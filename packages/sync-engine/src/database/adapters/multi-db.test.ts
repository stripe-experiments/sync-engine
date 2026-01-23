import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import type { DatabaseAdapter, DatabaseType } from './types.js'
import { getSupportedDatabaseTypes, createAdapterFromUrl } from './index.js'

/**
 * Database configurations for testing
 * Uses environment variables with sensible defaults
 */
const DATABASE_CONFIGS: Record<DatabaseType, { url: string; skip?: boolean }> = {
  postgres: {
    url: process.env.TEST_POSTGRES_URL || 'postgres://postgres:postgres@localhost:55432/postgres',
  },
  mysql: {
    url: process.env.TEST_MYSQL_URL || 'mysql://root:root@localhost:3306/stripe_test',
  },
  sqlite: {
    url: process.env.TEST_SQLITE_URL || ':memory:',
  },
  duckdb: {
    url: process.env.TEST_DUCKDB_URL || ':memory:',
  },
}

/**
 * Get databases to test based on environment variable
 * TEST_DATABASES=postgres,sqlite - only test specific databases
 * TEST_DATABASES=all or not set - test all databases
 */
function getDatabasesToTest(): DatabaseType[] {
  const envValue = process.env.TEST_DATABASES
  if (!envValue || envValue === 'all') {
    return getSupportedDatabaseTypes()
  }
  return envValue.split(',').map((db) => db.trim()) as DatabaseType[]
}

const databasesToTest = getDatabasesToTest()

describe.each(databasesToTest)('%s adapter', (dbType) => {
  const config = DATABASE_CONFIGS[dbType]
  let adapter: DatabaseAdapter

  // Skip if explicitly marked to skip
  if (config.skip) {
    it.skip(`${dbType} is skipped`, () => {})
    return
  }

  beforeAll(async () => {
    try {
      // Use dynamic import via createAdapterFromUrl
      adapter = await createAdapterFromUrl(dbType, config.url)
      await adapter.connect()
    } catch (error) {
      console.error(`Failed to connect to ${dbType}:`, error)
      throw error
    }
  })

  afterAll(async () => {
    if (adapter) {
      await adapter.close()
    }
  })

  beforeEach(async () => {
    // Clean up test tables before each test
    const schema = dbType === 'sqlite' ? '' : 'test_schema'
    const tableName = dbType === 'sqlite' ? 'test_schema_test_table' : 'test_table'
    const qualifiedTable = adapter.dialect.qualifyTable(schema || 'test_schema', 'test_table')

    try {
      // Try to drop the table if it exists
      if (dbType === 'sqlite') {
        await adapter.query(`DROP TABLE IF EXISTS "${tableName}"`)
      } else {
        await adapter.query(`DROP TABLE IF EXISTS ${qualifiedTable}`)
      }
    } catch {
      // Ignore errors - table might not exist
    }
  })

  describe('connection', () => {
    it('connects successfully', () => {
      expect(adapter).toBeDefined()
      expect(adapter.type).toBe(dbType)
    })

    it('has correct dialect properties', () => {
      expect(adapter.dialect.name).toBe(dbType)
    })
  })

  describe('dialect', () => {
    it('quotes identifiers correctly', () => {
      const quoted = adapter.dialect.quoteIdentifier('my_table')
      if (dbType === 'mysql') {
        expect(quoted).toBe('`my_table`')
      } else {
        expect(quoted).toBe('"my_table"')
      }
    })

    it('generates correct placeholders', () => {
      const p0 = adapter.dialect.placeholder(0)
      const p1 = adapter.dialect.placeholder(1)

      if (dbType === 'postgres' || dbType === 'duckdb') {
        expect(p0).toBe('$1')
        expect(p1).toBe('$2')
      } else {
        expect(p0).toBe('?')
        expect(p1).toBe('?')
      }
    })

    it('generates multiple placeholders', () => {
      const placeholders = adapter.dialect.placeholders(3)
      expect(placeholders).toHaveLength(3)
    })

    it('qualifies table names correctly', () => {
      const qualified = adapter.dialect.qualifyTable('my_schema', 'my_table')

      if (dbType === 'sqlite') {
        // SQLite uses table prefix since it doesn't support schemas
        expect(qualified).toBe('"my_schema_my_table"')
      } else if (dbType === 'mysql') {
        expect(qualified).toBe('`my_schema`.`my_table`')
      } else {
        expect(qualified).toBe('"my_schema"."my_table"')
      }
    })
  })

  describe('basic queries', () => {
    it('executes a simple SELECT', async () => {
      const result = await adapter.query<{ val: number }>('SELECT 1 as val')
      expect(result.rows).toHaveLength(1)
      expect(result.rows[0].val).toBe(1)
    })

    it('executes SELECT with parameters', async () => {
      const placeholder = adapter.dialect.placeholder(0)
      const result = await adapter.query<{ val: number }>(
        `SELECT ${placeholder} as val`,
        [42]
      )
      expect(result.rows).toHaveLength(1)
      // PostgreSQL may return untyped parameters as strings
      expect(Number(result.rows[0].val)).toBe(42)
    })
  })

  describe('schema and table operations', () => {
    it('creates schema (if supported)', async () => {
      if (!adapter.supportsSchemas) {
        // SQLite doesn't support schemas
        return
      }

      const createSchemaSql = adapter.dialect.createSchema('test_schema')
      if (createSchemaSql) {
        await adapter.query(createSchemaSql)
      }
    })

    it('creates a table', async () => {
      // Create schema first if supported
      if (adapter.supportsSchemas) {
        const createSchemaSql = adapter.dialect.createSchema('test_schema')
        if (createSchemaSql) {
          await adapter.query(createSchemaSql)
        }
      }

      // Build CREATE TABLE based on dialect
      const tableName = adapter.supportsSchemas
        ? adapter.dialect.qualifyTable('test_schema', 'test_table')
        : adapter.dialect.quoteIdentifier('test_schema_test_table')

      const idCol = adapter.dialect.quoteIdentifier('id')
      const nameCol = adapter.dialect.quoteIdentifier('name')
      const dataCol = adapter.dialect.quoteIdentifier('data')

      let createTableSql: string
      if (dbType === 'mysql') {
        createTableSql = `
          CREATE TABLE ${tableName} (
            ${idCol} VARCHAR(255) PRIMARY KEY,
            ${nameCol} VARCHAR(255),
            ${dataCol} JSON
          )
        `
      } else if (dbType === 'sqlite') {
        createTableSql = `
          CREATE TABLE ${tableName} (
            ${idCol} TEXT PRIMARY KEY,
            ${nameCol} TEXT,
            ${dataCol} TEXT
          )
        `
      } else {
        // PostgreSQL, DuckDB
        createTableSql = `
          CREATE TABLE ${tableName} (
            ${idCol} TEXT PRIMARY KEY,
            ${nameCol} TEXT,
            ${dataCol} ${dbType === 'postgres' ? 'JSONB' : 'JSON'}
          )
        `
      }

      await adapter.query(createTableSql)
    })
  })

  describe('CRUD operations', () => {
    const testSchema = 'test_schema'
    const testTable = 'crud_table'

    beforeEach(async () => {
      // Create schema and table for CRUD tests
      if (adapter.supportsSchemas) {
        const createSchemaSql = adapter.dialect.createSchema(testSchema)
        if (createSchemaSql) {
          await adapter.query(createSchemaSql)
        }
      }

      const tableName = adapter.supportsSchemas
        ? adapter.dialect.qualifyTable(testSchema, testTable)
        : adapter.dialect.quoteIdentifier(`${testSchema}_${testTable}`)

      // Drop table if exists
      await adapter.query(`DROP TABLE IF EXISTS ${tableName}`)

      const idCol = adapter.dialect.quoteIdentifier('id')
      const nameCol = adapter.dialect.quoteIdentifier('name')
      const valueCol = adapter.dialect.quoteIdentifier('value')

      let createSql: string
      if (dbType === 'mysql') {
        createSql = `CREATE TABLE ${tableName} (${idCol} VARCHAR(255) PRIMARY KEY, ${nameCol} VARCHAR(255), ${valueCol} INT)`
      } else {
        createSql = `CREATE TABLE ${tableName} (${idCol} TEXT PRIMARY KEY, ${nameCol} TEXT, ${valueCol} INTEGER)`
      }
      await adapter.query(createSql)
    })

    it('inserts a row', async () => {
      const tableName = adapter.supportsSchemas
        ? adapter.dialect.qualifyTable(testSchema, testTable)
        : adapter.dialect.quoteIdentifier(`${testSchema}_${testTable}`)

      const insertSql = adapter.dialect.buildInsert(tableName, ['id', 'name', 'value'])

      // For databases without RETURNING, just check the insert succeeds
      const result = await adapter.query(insertSql, ['test1', 'Test Item', 100])

      if (adapter.supportsReturning) {
        expect(result.rows).toHaveLength(1)
      } else {
        expect(result.rowCount).toBeGreaterThanOrEqual(0) // MySQL returns 1, SQLite returns 0
      }

      // Verify the insert
      const selectResult = await adapter.query<{ id: string; name: string; value: number }>(
        `SELECT * FROM ${tableName} WHERE ${adapter.dialect.quoteIdentifier('id')} = ${adapter.dialect.placeholder(0)}`,
        ['test1']
      )
      expect(selectResult.rows).toHaveLength(1)
      expect(selectResult.rows[0].name).toBe('Test Item')
      expect(selectResult.rows[0].value).toBe(100)
    })

    it('upserts a row (insert)', async () => {
      const tableName = adapter.supportsSchemas
        ? adapter.dialect.qualifyTable(testSchema, testTable)
        : adapter.dialect.quoteIdentifier(`${testSchema}_${testTable}`)

      const upsertSql = adapter.dialect.buildUpsert(
        tableName,
        ['id', 'name', 'value'],
        ['id'],
        ['name', 'value']
      )

      await adapter.query(upsertSql, ['upsert1', 'Original', 50])

      const result = await adapter.query<{ name: string; value: number }>(
        `SELECT * FROM ${tableName} WHERE ${adapter.dialect.quoteIdentifier('id')} = ${adapter.dialect.placeholder(0)}`,
        ['upsert1']
      )
      expect(result.rows[0].name).toBe('Original')
      expect(result.rows[0].value).toBe(50)
    })

    it('upserts a row (update)', async () => {
      const tableName = adapter.supportsSchemas
        ? adapter.dialect.qualifyTable(testSchema, testTable)
        : adapter.dialect.quoteIdentifier(`${testSchema}_${testTable}`)

      const upsertSql = adapter.dialect.buildUpsert(
        tableName,
        ['id', 'name', 'value'],
        ['id'],
        ['name', 'value']
      )

      // First insert
      await adapter.query(upsertSql, ['upsert2', 'Original', 100])

      // Update via upsert
      await adapter.query(upsertSql, ['upsert2', 'Updated', 200])

      const result = await adapter.query<{ name: string; value: number }>(
        `SELECT * FROM ${tableName} WHERE ${adapter.dialect.quoteIdentifier('id')} = ${adapter.dialect.placeholder(0)}`,
        ['upsert2']
      )
      expect(result.rows).toHaveLength(1)
      expect(result.rows[0].name).toBe('Updated')
      expect(result.rows[0].value).toBe(200)
    })

    it('deletes a row', async () => {
      const tableName = adapter.supportsSchemas
        ? adapter.dialect.qualifyTable(testSchema, testTable)
        : adapter.dialect.quoteIdentifier(`${testSchema}_${testTable}`)

      // Insert first
      const insertSql = adapter.dialect.buildInsert(tableName, ['id', 'name', 'value'])
      await adapter.query(insertSql, ['delete1', 'To Delete', 999])

      // Delete
      const deleteSql = adapter.dialect.buildDelete(tableName, 'id')
      await adapter.query(deleteSql, ['delete1'])

      // Verify deletion
      const result = await adapter.query(
        `SELECT * FROM ${tableName} WHERE ${adapter.dialect.quoteIdentifier('id')} = ${adapter.dialect.placeholder(0)}`,
        ['delete1']
      )
      expect(result.rows).toHaveLength(0)
    })
  })

  describe('transactions', () => {
    const testSchema = 'test_schema'
    const testTable = 'tx_table'

    beforeEach(async () => {
      if (adapter.supportsSchemas) {
        const createSchemaSql = adapter.dialect.createSchema(testSchema)
        if (createSchemaSql) {
          await adapter.query(createSchemaSql)
        }
      }

      const tableName = adapter.supportsSchemas
        ? adapter.dialect.qualifyTable(testSchema, testTable)
        : adapter.dialect.quoteIdentifier(`${testSchema}_${testTable}`)

      await adapter.query(`DROP TABLE IF EXISTS ${tableName}`)

      const idCol = adapter.dialect.quoteIdentifier('id')
      const valCol = adapter.dialect.quoteIdentifier('val')

      let createSql: string
      if (dbType === 'mysql') {
        createSql = `CREATE TABLE ${tableName} (${idCol} VARCHAR(255) PRIMARY KEY, ${valCol} INT)`
      } else {
        createSql = `CREATE TABLE ${tableName} (${idCol} TEXT PRIMARY KEY, ${valCol} INTEGER)`
      }
      await adapter.query(createSql)
    })

    it('commits a transaction', async () => {
      const tableName = adapter.supportsSchemas
        ? adapter.dialect.qualifyTable(testSchema, testTable)
        : adapter.dialect.quoteIdentifier(`${testSchema}_${testTable}`)

      await adapter.withTransaction(async () => {
        const insertSql = adapter.dialect.buildInsert(tableName, ['id', 'val'])
        await adapter.query(insertSql, ['tx1', 100])
      })

      const result = await adapter.query<{ val: number }>(
        `SELECT * FROM ${tableName} WHERE ${adapter.dialect.quoteIdentifier('id')} = ${adapter.dialect.placeholder(0)}`,
        ['tx1']
      )
      expect(result.rows).toHaveLength(1)
      expect(result.rows[0].val).toBe(100)
    })

    it('rolls back a transaction on error', async () => {
      const tableName = adapter.supportsSchemas
        ? adapter.dialect.qualifyTable(testSchema, testTable)
        : adapter.dialect.quoteIdentifier(`${testSchema}_${testTable}`)

      try {
        await adapter.withTransaction(async () => {
          const insertSql = adapter.dialect.buildInsert(tableName, ['id', 'val'])
          await adapter.query(insertSql, ['tx2', 200])
          throw new Error('Intentional rollback')
        })
      } catch {
        // Expected
      }

      const result = await adapter.query(
        `SELECT * FROM ${tableName} WHERE ${adapter.dialect.quoteIdentifier('id')} = ${adapter.dialect.placeholder(0)}`,
        ['tx2']
      )
      expect(result.rows).toHaveLength(0)
    })
  })

  describe('JSON operations', () => {
    const testSchema = 'test_schema'
    const testTable = 'json_table'

    beforeEach(async () => {
      if (adapter.supportsSchemas) {
        const createSchemaSql = adapter.dialect.createSchema(testSchema)
        if (createSchemaSql) {
          await adapter.query(createSchemaSql)
        }
      }

      const tableName = adapter.supportsSchemas
        ? adapter.dialect.qualifyTable(testSchema, testTable)
        : adapter.dialect.quoteIdentifier(`${testSchema}_${testTable}`)

      await adapter.query(`DROP TABLE IF EXISTS ${tableName}`)

      const idCol = adapter.dialect.quoteIdentifier('id')
      const dataCol = adapter.dialect.quoteIdentifier('data')

      let createSql: string
      if (dbType === 'mysql') {
        createSql = `CREATE TABLE ${tableName} (${idCol} VARCHAR(255) PRIMARY KEY, ${dataCol} JSON)`
      } else if (dbType === 'sqlite') {
        createSql = `CREATE TABLE ${tableName} (${idCol} TEXT PRIMARY KEY, ${dataCol} TEXT)`
      } else if (dbType === 'postgres') {
        createSql = `CREATE TABLE ${tableName} (${idCol} TEXT PRIMARY KEY, ${dataCol} JSONB)`
      } else {
        createSql = `CREATE TABLE ${tableName} (${idCol} TEXT PRIMARY KEY, ${dataCol} JSON)`
      }
      await adapter.query(createSql)
    })

    it('stores and retrieves JSON data', async () => {
      const tableName = adapter.supportsSchemas
        ? adapter.dialect.qualifyTable(testSchema, testTable)
        : adapter.dialect.quoteIdentifier(`${testSchema}_${testTable}`)

      const testData = { name: 'Test', value: 42, nested: { foo: 'bar' } }

      const insertSql = adapter.dialect.buildInsert(tableName, ['id', 'data'])
      await adapter.query(insertSql, ['json1', JSON.stringify(testData)])

      const result = await adapter.query<{ data: string | object }>(
        `SELECT * FROM ${tableName} WHERE ${adapter.dialect.quoteIdentifier('id')} = ${adapter.dialect.placeholder(0)}`,
        ['json1']
      )

      expect(result.rows).toHaveLength(1)

      // Parse data if it's a string (SQLite), otherwise it should already be an object
      const data =
        typeof result.rows[0].data === 'string'
          ? JSON.parse(result.rows[0].data)
          : result.rows[0].data

      expect(data.name).toBe('Test')
      expect(data.value).toBe(42)
      expect(data.nested.foo).toBe('bar')
    })

    it('extracts JSON field values', async () => {
      const tableName = adapter.supportsSchemas
        ? adapter.dialect.qualifyTable(testSchema, testTable)
        : adapter.dialect.quoteIdentifier(`${testSchema}_${testTable}`)

      const testData = { name: 'Extract Test', amount: 999 }

      const insertSql = adapter.dialect.buildInsert(tableName, ['id', 'data'])
      await adapter.query(insertSql, ['json2', JSON.stringify(testData)])

      // Test JSON extraction
      const dataCol = adapter.dialect.quoteIdentifier('data')
      const extractExpr = adapter.dialect.jsonExtractText(dataCol, 'name')

      const result = await adapter.query<{ extracted: string }>(
        `SELECT ${extractExpr} as extracted FROM ${tableName} WHERE ${adapter.dialect.quoteIdentifier('id')} = ${adapter.dialect.placeholder(0)}`,
        ['json2']
      )

      expect(result.rows).toHaveLength(1)
      expect(result.rows[0].extracted).toBe('Extract Test')
    })
  })
})

// Summary test to ensure all database types are represented
describe('Multi-Database Test Suite', () => {
  it('tests all configured database types', () => {
    console.log(`Testing databases: ${databasesToTest.join(', ')}`)
    expect(databasesToTest.length).toBeGreaterThan(0)
  })
})
