/**
 * Tests for Database Introspection Module
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { PostgresClient } from '../postgres'
import { DatabaseIntrospector, createDatabaseIntrospector } from '../introspection'

const TEST_DATABASE_URL = process.env.TEST_POSTGRES_DB_URL || 'postgresql://postgres:postgres@localhost:55432/postgres'

describe('DatabaseIntrospector', () => {
  let client: PostgresClient
  let introspector: DatabaseIntrospector

  beforeAll(async () => {
    client = new PostgresClient({
      schema: 'test_introspection',
      poolConfig: { connectionString: TEST_DATABASE_URL },
    })
    introspector = createDatabaseIntrospector(client)

    // Create test schema
    await client.query('CREATE SCHEMA IF NOT EXISTS test_introspection')
  })

  afterAll(async () => {
    // Clean up test schema
    await client.query('DROP SCHEMA IF EXISTS test_introspection CASCADE')
    await client.pool.end()
  })

  beforeEach(async () => {
    // Clean up any existing test tables
    const tables = await introspector.listTables('test_introspection')
    for (const table of tables) {
      await client.query(`DROP TABLE IF EXISTS "test_introspection"."${table}" CASCADE`)
    }
  })

  describe('schemaExists', () => {
    it('should return true for existing schema', async () => {
      const exists = await introspector.schemaExists('test_introspection')
      expect(exists).toBe(true)
    })

    it('should return false for non-existing schema', async () => {
      const exists = await introspector.schemaExists('nonexistent_schema')
      expect(exists).toBe(false)
    })
  })

  describe('listTables', () => {
    it('should return empty list for schema with no tables', async () => {
      const tables = await introspector.listTables('test_introspection')
      expect(tables).toEqual([])
    })

    it('should list existing tables', async () => {
      // Create test table
      await client.query(`
        CREATE TABLE "test_introspection"."test_table" (
          id text PRIMARY KEY,
          name text NOT NULL
        )
      `)

      const tables = await introspector.listTables('test_introspection')
      expect(tables).toContain('test_table')
    })
  })

  describe('getTableColumns', () => {
    beforeEach(async () => {
      // Create comprehensive test table
      await client.query(`
        CREATE TABLE "test_introspection"."comprehensive_table" (
          id text PRIMARY KEY,
          name text NOT NULL,
          age bigint,
          balance numeric,
          active boolean,
          metadata jsonb,
          tags text[],
          optional_field text DEFAULT 'default_value'
        )
      `)
    })

    it('should return empty array for non-existent table', async () => {
      const columns = await introspector.getTableColumns('nonexistent', 'test_introspection')
      expect(columns).toEqual([])
    })

    it('should return all columns with correct information', async () => {
      const columns = await introspector.getTableColumns('comprehensive_table', 'test_introspection')

      expect(columns).toHaveLength(8)

      // Find specific columns
      const idColumn = columns.find(c => c.columnName === 'id')
      expect(idColumn).toMatchObject({
        columnName: 'id',
        dataType: 'text',
        isNullable: false,
        isPrimaryKey: true,
      })

      const nameColumn = columns.find(c => c.columnName === 'name')
      expect(nameColumn).toMatchObject({
        columnName: 'name',
        dataType: 'text',
        isNullable: false,
        isPrimaryKey: false,
      })

      const ageColumn = columns.find(c => c.columnName === 'age')
      expect(ageColumn).toMatchObject({
        columnName: 'age',
        dataType: 'bigint',
        isNullable: true,
        isPrimaryKey: false,
      })

      const metadataColumn = columns.find(c => c.columnName === 'metadata')
      expect(metadataColumn).toMatchObject({
        columnName: 'metadata',
        dataType: 'jsonb',
        isNullable: true,
      })

      const tagsColumn = columns.find(c => c.columnName === 'tags')
      expect(tagsColumn).toMatchObject({
        columnName: 'tags',
        dataType: 'ARRAY',
        isNullable: true,
      })
    })
  })

  describe('getTableIndexes', () => {
    beforeEach(async () => {
      // Create table with indexes
      await client.query(`
        CREATE TABLE "test_introspection"."indexed_table" (
          id text PRIMARY KEY,
          email text,
          metadata jsonb,
          tags text[]
        )
      `)

      // Create various indexes
      await client.query(`
        CREATE INDEX idx_email ON "test_introspection"."indexed_table"(email)
      `)
      await client.query(`
        CREATE INDEX idx_metadata ON "test_introspection"."indexed_table" USING GIN (metadata)
      `)
      await client.query(`
        CREATE UNIQUE INDEX idx_unique_email ON "test_introspection"."indexed_table"(email)
        WHERE email IS NOT NULL
      `)
    })

    it('should return empty array for table with no indexes', async () => {
      await client.query(`
        CREATE TABLE "test_introspection"."no_indexes" (
          id text,
          name text
        )
      `)

      const indexes = await introspector.getTableIndexes('no_indexes', 'test_introspection')
      expect(indexes).toEqual([])
    })

    it('should return all indexes with correct information', async () => {
      const indexes = await introspector.getTableIndexes('indexed_table', 'test_introspection')

      expect(indexes.length).toBeGreaterThanOrEqual(2) // Should have at least our created indexes

      // Check B-tree index
      const emailIndex = indexes.find(i => i.indexName === 'idx_email')
      expect(emailIndex).toMatchObject({
        indexName: 'idx_email',
        indexType: 'btree',
        isUnique: false,
      })
      expect(emailIndex?.columns).toContain('email')

      // Check GIN index
      const metadataIndex = indexes.find(i => i.indexName === 'idx_metadata')
      expect(metadataIndex).toMatchObject({
        indexName: 'idx_metadata',
        indexType: 'gin',
        isUnique: false,
      })
    })
  })

  describe('getTableInfo', () => {
    beforeEach(async () => {
      await client.query(`
        CREATE TABLE "test_introspection"."full_table" (
          id text PRIMARY KEY,
          name text NOT NULL,
          metadata jsonb
        )
      `)

      await client.query(`
        CREATE INDEX idx_name ON "test_introspection"."full_table"(name)
      `)
    })

    it('should return null for non-existent table', async () => {
      const tableInfo = await introspector.getTableInfo('nonexistent', 'test_introspection')
      expect(tableInfo).toBeNull()
    })

    it('should return complete table information', async () => {
      const tableInfo = await introspector.getTableInfo('full_table', 'test_introspection')

      expect(tableInfo).not.toBeNull()
      expect(tableInfo!.tableName).toBe('full_table')
      expect(tableInfo!.schemaName).toBe('test_introspection')
      expect(tableInfo!.columns).toHaveLength(3)
      expect(tableInfo!.primaryKeys).toEqual(['id'])
      expect(tableInfo!.indexes.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('normalizePostgresType', () => {
    it('should normalize common Postgres types correctly', () => {
      expect(introspector.normalizePostgresType('text')).toBe('text')
      expect(introspector.normalizePostgresType('varchar')).toBe('text')
      expect(introspector.normalizePostgresType('character varying')).toBe('text')

      expect(introspector.normalizePostgresType('bigint')).toBe('bigint')
      expect(introspector.normalizePostgresType('int8')).toBe('bigint')
      expect(introspector.normalizePostgresType('integer')).toBe('bigint')
      expect(introspector.normalizePostgresType('int4')).toBe('bigint')

      expect(introspector.normalizePostgresType('numeric')).toBe('numeric')
      expect(introspector.normalizePostgresType('decimal')).toBe('numeric')

      expect(introspector.normalizePostgresType('boolean')).toBe('boolean')
      expect(introspector.normalizePostgresType('bool')).toBe('boolean')

      expect(introspector.normalizePostgresType('jsonb')).toBe('jsonb')

      expect(introspector.normalizePostgresType('text[]')).toBe('text[]')
      expect(introspector.normalizePostgresType('_text')).toBe('text[]')
    })

    it('should default to text for unknown types', () => {
      expect(introspector.normalizePostgresType('unknown_type')).toBe('text')
    })
  })

  describe('convertToColumnDefinition', () => {
    it('should convert database column info correctly', () => {
      const dbColumn = {
        columnName: 'test_field',
        dataType: 'bigint',
        isNullable: true,
        isPrimaryKey: false,
        columnDefault: null,
      }

      const columnDef = introspector.convertToColumnDefinition(dbColumn)

      expect(columnDef).toMatchObject({
        name: 'test_field',
        type: 'bigint',
        nullable: true,
        primaryKey: false,
        indexingOptions: [],
      })
    })

    it('should handle primary key columns', () => {
      const dbColumn = {
        columnName: 'id',
        dataType: 'text',
        isNullable: false,
        isPrimaryKey: true,
        columnDefault: null,
      }

      const columnDef = introspector.convertToColumnDefinition(dbColumn)

      expect(columnDef).toMatchObject({
        name: 'id',
        type: 'text',
        nullable: false,
        primaryKey: true,
      })
    })
  })
})