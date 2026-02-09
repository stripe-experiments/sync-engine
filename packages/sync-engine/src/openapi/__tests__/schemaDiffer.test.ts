/**
 * Tests for Schema Diffing Logic
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { writeFileSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { PostgresClient } from '../../database/postgres'
import { createDatabaseIntrospector } from '../../database/introspection'
import { createOpenAPIParser } from '../parser'
import { createTypeMapper } from '../typeMapper'
import { createTableGenerator } from '../tableGenerator'
import { createSchemaDiffer, type SchemaDiff } from '../schemaDiffer'

const TEST_DATABASE_URL = process.env.TEST_POSTGRES_DB_URL || 'postgresql://postgres:postgres@localhost:55432/postgres'

// Mock OpenAPI spec for testing
const mockOpenAPISpec = {
  info: { version: '2024-12-18' },
  components: {
    schemas: {
      customer: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          object: { type: 'string' },
          email: { type: 'string', nullable: true },
          name: { type: 'string', nullable: true },
          metadata: {
            type: 'object',
            additionalProperties: { type: 'string' }
          },
          created: { type: 'integer', format: 'unix-time' },
          balance: { type: 'integer' },
          delinquent: { type: 'boolean' }
        },
        required: ['id', 'object']
      },
      charge: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          object: { type: 'string' },
          amount: { type: 'integer' },
          currency: { type: 'string' },
          customer: { type: 'string', nullable: true },
          description: { type: 'string', nullable: true },
          metadata: {
            type: 'object',
            additionalProperties: { type: 'string' }
          },
          status: { type: 'string' }
        },
        required: ['id', 'object', 'amount', 'currency']
      }
    }
  }
}

describe('SchemaDiffer', () => {
  let client: PostgresClient
  let introspector: ReturnType<typeof createDatabaseIntrospector>
  let parser: ReturnType<typeof createOpenAPIParser>
  let typeMapper: ReturnType<typeof createTypeMapper>
  let tableGenerator: ReturnType<typeof createTableGenerator>
  let differ: ReturnType<typeof createSchemaDiffer>
  let tempDir: string
  let specPath: string

  beforeAll(async () => {
    // Create temporary directory for spec files
    tempDir = mkdtempSync(join(tmpdir(), 'schema-differ-test-'))
    specPath = join(tempDir, 'spec.json')

    // Write mock spec to file
    writeFileSync(specPath, JSON.stringify(mockOpenAPISpec, null, 2))

    // Initialize components
    client = new PostgresClient({
      schema: 'test_differ',
      poolConfig: { connectionString: TEST_DATABASE_URL },
    })

    introspector = createDatabaseIntrospector(client)
    parser = createOpenAPIParser()
    typeMapper = createTypeMapper()
    tableGenerator = createTableGenerator(parser, typeMapper)
    differ = createSchemaDiffer(parser, typeMapper, tableGenerator, introspector)

    // Create test schema
    await client.query('CREATE SCHEMA IF NOT EXISTS test_differ')
  })

  afterAll(async () => {
    // Clean up
    await client.query('DROP SCHEMA IF EXISTS test_differ CASCADE')
    await client.pool.end()
    rmSync(tempDir, { recursive: true, force: true })
  })

  beforeEach(async () => {
    // Clean up any existing test tables
    const tables = await introspector.listTables('test_differ')
    for (const table of tables) {
      await client.query(`DROP TABLE IF EXISTS "test_differ"."${table}" CASCADE`)
    }
  })

  describe('compareSchemas', () => {
    it('should detect missing tables', async () => {
      const result = await differ.compareSchemas({
        databaseUrl: TEST_DATABASE_URL,
        openApiSpecPath: specPath,
        objects: ['customer', 'charge'],
        schema: 'test_differ',
      })

      expect(result.summary.totalTables).toBe(2)
      expect(result.summary.missingTables).toBe(2)
      expect(result.summary.identicalTables).toBe(0)

      const customerDiff = result.diffs.find(d => d.tableName === 'customers')
      expect(customerDiff?.status).toBe('missing')

      const chargeDiff = result.diffs.find(d => d.tableName === 'charges')
      expect(chargeDiff?.status).toBe('missing')
    })

    it('should detect identical tables', async () => {
      // Create table matching expected schema
      await client.query(`
        CREATE TABLE "test_differ"."customers" (
          id text PRIMARY KEY,
          object text,
          email text,
          name text,
          metadata jsonb,
          created bigint,
          balance bigint,
          delinquent boolean
        )
      `)

      const result = await differ.compareSchemas({
        databaseUrl: TEST_DATABASE_URL,
        openApiSpecPath: specPath,
        objects: ['customer'],
        schema: 'test_differ',
      })

      expect(result.summary.identicalTables).toBe(1)
      const customerDiff = result.diffs.find(d => d.tableName === 'customers')
      expect(customerDiff?.status).toBe('identical')
    })

    it('should detect extra tables', async () => {
      // Create table not in OpenAPI spec
      await client.query(`
        CREATE TABLE "test_differ"."extra_table" (
          id text PRIMARY KEY,
          data text
        )
      `)

      const result = await differ.compareSchemas({
        databaseUrl: TEST_DATABASE_URL,
        openApiSpecPath: specPath,
        objects: ['customer'],
        schema: 'test_differ',
      })

      expect(result.summary.extraTables).toBe(1)
      const extraDiff = result.diffs.find(d => d.tableName === 'extra_table')
      expect(extraDiff?.status).toBe('extra')
    })

    it('should detect column differences', async () => {
      // Create table with missing and extra columns
      await client.query(`
        CREATE TABLE "test_differ"."customers" (
          id text PRIMARY KEY,
          object text,
          email text,
          -- missing: name, metadata, created, balance, delinquent
          legacy_field text -- extra column
        )
      `)

      const result = await differ.compareSchemas({
        databaseUrl: TEST_DATABASE_URL,
        openApiSpecPath: specPath,
        objects: ['customer'],
        schema: 'test_differ',
      })

      expect(result.summary.differentTables).toBe(1)
      const customerDiff = result.diffs.find(d => d.tableName === 'customers')
      expect(customerDiff?.status).toBe('different')

      // Should have columns to add
      expect(customerDiff?.columnsToAdd.length).toBeGreaterThan(0)
      const columnsToAddNames = customerDiff?.columnsToAdd.map(c => c.name) || []
      expect(columnsToAddNames).toContain('name')
      expect(columnsToAddNames).toContain('metadata')

      // Should have columns to remove
      expect(customerDiff?.columnsToRemove.length).toBe(1)
      expect(customerDiff?.columnsToRemove[0].name).toBe('legacy_field')
    })

    it('should detect column type differences', async () => {
      // Create table with wrong column types
      await client.query(`
        CREATE TABLE "test_differ"."customers" (
          id text PRIMARY KEY,
          object text,
          email text,
          name text,
          metadata text, -- should be jsonb
          created integer, -- should be bigint
          balance text, -- should be bigint
          delinquent text -- should be boolean
        )
      `)

      const result = await differ.compareSchemas({
        databaseUrl: TEST_DATABASE_URL,
        openApiSpecPath: specPath,
        objects: ['customer'],
        schema: 'test_differ',
      })

      const customerDiff = result.diffs.find(d => d.tableName === 'customers')
      expect(customerDiff?.status).toBe('different')
      expect(customerDiff?.columnsToModify.length).toBeGreaterThan(0)

      // Check specific modifications
      const metadataMod = customerDiff?.columnsToModify.find(m => m.name === 'metadata')
      expect(metadataMod).toMatchObject({
        name: 'metadata',
        currentType: 'text',
        expectedType: 'jsonb',
        isSafe: false, // Type change is unsafe
      })
    })
  })

  describe('generateMigrationScript', () => {
    it('should generate CREATE TABLE for missing tables', () => {
      const diffs: SchemaDiff[] = [
        {
          tableName: 'customers',
          status: 'missing',
          columnsToAdd: [],
          columnsToRemove: [],
          columnsToModify: [],
          suggestedIndexes: [],
        },
      ]

      const script = differ.generateMigrationScript(diffs, 'test_differ')

      expect(script).toContain('CREATE TABLE IF NOT EXISTS "test_differ"."customers"')
      expect(script).toContain('Generated at:')
    })

    it('should generate ALTER TABLE for different tables', () => {
      const diffs: SchemaDiff[] = [
        {
          tableName: 'customers',
          status: 'different',
          columnsToAdd: [
            {
              name: 'new_field',
              type: 'text',
              nullable: true,
              primaryKey: false,
              indexingOptions: [],
            },
          ],
          columnsToRemove: [
            {
              name: 'old_field',
              type: 'text',
              nullable: true,
              primaryKey: false,
              indexingOptions: [],
            },
          ],
          columnsToModify: [
            {
              name: 'balance',
              currentType: 'integer',
              expectedType: 'bigint',
              nullable: { current: true, expected: true },
              isSafe: true,
              reason: 'Type change: integer → bigint',
            },
          ],
          suggestedIndexes: [],
        },
      ]

      const script = differ.generateMigrationScript(diffs, 'test_differ')

      expect(script).toContain('ALTER TABLE "test_differ"."customers" ADD COLUMN "new_field" text;')
      expect(script).toContain('DROP COLUMN "old_field"')
      expect(script).toContain('Type change: integer → bigint (SAFE)')
    })

    it('should include index recommendations', () => {
      const diffs: SchemaDiff[] = [
        {
          tableName: 'customers',
          status: 'identical',
          columnsToAdd: [],
          columnsToRemove: [],
          columnsToModify: [],
          suggestedIndexes: [
            {
              columnName: 'email',
              indexType: 'btree',
              reason: 'Commonly queried field',
              sql: 'CREATE INDEX idx_customers_email ON "test_differ"."customers"("email");',
            },
          ],
        },
      ]

      const script = differ.generateMigrationScript(diffs, 'test_differ')

      expect(script).toContain('Recommended indexes:')
      expect(script).toContain('CREATE INDEX idx_customers_email')
    })
  })

  describe('error handling', () => {
    it('should handle invalid OpenAPI spec path', async () => {
      await expect(
        differ.compareSchemas({
          databaseUrl: TEST_DATABASE_URL,
          openApiSpecPath: '/nonexistent/spec.json',
          objects: ['customer'],
          schema: 'test_differ',
        })
      ).rejects.toThrow()
    })

    it('should handle invalid database connection', async () => {
      await expect(
        differ.compareSchemas({
          databaseUrl: 'postgresql://invalid:invalid@localhost:99999/invalid',
          openApiSpecPath: specPath,
          objects: ['customer'],
          schema: 'test_differ',
        })
      ).rejects.toThrow()
    })

    it('should handle unknown object names', async () => {
      await expect(
        differ.compareSchemas({
          databaseUrl: TEST_DATABASE_URL,
          openApiSpecPath: specPath,
          objects: ['nonexistent_object'],
          schema: 'test_differ',
        })
      ).rejects.toThrow(/not found in OpenAPI spec/)
    })
  })

  describe('index suggestions', () => {
    beforeEach(async () => {
      await parser.loadSpec(specPath)
    })

    it('should suggest indexes for commonly queried fields', async () => {
      const result = await differ.compareSchemas({
        databaseUrl: TEST_DATABASE_URL,
        openApiSpecPath: specPath,
        objects: ['customer'],
        schema: 'test_differ',
        suggestIndexes: true,
      })

      const customerDiff = result.diffs.find(d => d.tableName === 'customers')
      expect(customerDiff?.suggestedIndexes.length).toBeGreaterThan(0)

      // Should suggest index for email (common field)
      const emailIndexSuggestion = customerDiff?.suggestedIndexes.find(
        i => i.columnName === 'email'
      )
      expect(emailIndexSuggestion).toBeDefined()

      // Should suggest GIN index for metadata (jsonb)
      const metadataIndexSuggestion = customerDiff?.suggestedIndexes.find(
        i => i.columnName === 'metadata'
      )
      expect(metadataIndexSuggestion?.indexType).toBe('gin')
    })

    it('should not suggest indexes when disabled', async () => {
      const result = await differ.compareSchemas({
        databaseUrl: TEST_DATABASE_URL,
        openApiSpecPath: specPath,
        objects: ['customer'],
        schema: 'test_differ',
        suggestIndexes: false,
      })

      const customerDiff = result.diffs.find(d => d.tableName === 'customers')
      expect(customerDiff?.suggestedIndexes).toEqual([])
    })
  })
})