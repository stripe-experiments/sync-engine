import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { BaseSyncClient } from './BaseSyncClient.js'
import { createSyncClient, createSyncClientFromUrl } from './createSyncClient.js'
import { generateSchema, parseSchemaStatements, STRIPE_TABLES, getTableName } from './schema.js'
import { createAdapterFromUrl } from './adapters/index.js'
import type { DatabaseAdapter } from './adapters/types.js'

/**
 * Tests for BaseSyncClient, createSyncClient factory, and schema generation.
 * Uses in-memory SQLite for fast, isolated tests.
 */

describe('Schema Generation', () => {
  it('generates valid schema for all database types', () => {
    const dbTypes = ['postgres', 'mysql', 'sqlite', 'duckdb']

    for (const dbType of dbTypes) {
      const schema = generateSchema(dbType)
      expect(schema).toBeTruthy()
      expect(schema.length).toBeGreaterThan(100)

      // Should contain all stripe tables
      for (const table of STRIPE_TABLES) {
        expect(schema).toContain(`stripe_${table}`)
      }

      // Should contain internal tables
      expect(schema).toContain('stripe__cursors')
      expect(schema).toContain('stripe__migrations')
    }
  })

  it('uses correct types for each database', () => {
    // PostgreSQL uses JSONB and TIMESTAMPTZ
    const pgSchema = generateSchema('postgres')
    expect(pgSchema).toContain('JSONB')
    expect(pgSchema).toContain('TIMESTAMPTZ')

    // MySQL uses JSON and DATETIME
    const mysqlSchema = generateSchema('mysql')
    expect(mysqlSchema).toContain('JSON')
    expect(mysqlSchema).toContain('DATETIME')
    expect(mysqlSchema).toContain('VARCHAR')

    // SQLite uses TEXT for everything
    const sqliteSchema = generateSchema('sqlite')
    expect(sqliteSchema).toContain('TEXT')
    expect(sqliteSchema).not.toContain('JSONB')

    // DuckDB uses JSON and TIMESTAMP
    const duckdbSchema = generateSchema('duckdb')
    expect(duckdbSchema).toContain('JSON')
    expect(duckdbSchema).toContain('TIMESTAMP')
  })

  it('parseSchemaStatements splits correctly', () => {
    const schema = generateSchema('sqlite')
    const statements = parseSchemaStatements(schema)

    // Should have CREATE TABLE + CREATE INDEX statements
    expect(statements.length).toBeGreaterThan(STRIPE_TABLES.length)

    // Each statement should be valid SQL
    for (const stmt of statements) {
      expect(stmt.startsWith('CREATE TABLE') || stmt.startsWith('CREATE INDEX')).toBe(true)
    }
  })

  it('getTableName adds stripe_ prefix', () => {
    expect(getTableName('customers')).toBe('stripe_customers')
    expect(getTableName('payment_intents')).toBe('stripe_payment_intents')
  })
})

describe('createSyncClient Factory', () => {
  it('creates DuckDB client', () => {
    const client = createSyncClient({ type: 'duckdb', url: ':memory:' })
    expect(client).toBeInstanceOf(BaseSyncClient)
  })

  it('creates SQLite client', () => {
    const client = createSyncClient({ type: 'sqlite', url: ':memory:' })
    expect(client).toBeInstanceOf(BaseSyncClient)
  })

  it('creates MySQL client', () => {
    // Just test factory works - actual connection would fail without server
    const client = createSyncClient({ type: 'mysql', url: 'mysql://localhost/test' })
    expect(client).toBeInstanceOf(BaseSyncClient)
  })

  it('throws for PostgreSQL (should use PostgresClient)', () => {
    expect(() => createSyncClient({ type: 'postgres', url: 'postgres://localhost/test' }))
      .toThrow('PostgreSQL should use PostgresClient')
  })

  it('createSyncClientFromUrl convenience function works', () => {
    const client = createSyncClientFromUrl('sqlite', ':memory:')
    expect(client).toBeInstanceOf(BaseSyncClient)
  })
})

describe('BaseSyncClient Operations', () => {
  let adapter: DatabaseAdapter
  let client: BaseSyncClient

  beforeAll(async () => {
    adapter = await createAdapterFromUrl('sqlite', ':memory:')
    await adapter.connect()
    client = new BaseSyncClient(adapter)
    await client.migrate()
  })

  afterAll(async () => {
    await client.close()
  })

  beforeEach(async () => {
    // Clean up test data between tests
    await adapter.query('DELETE FROM stripe_customers')
    await adapter.query('DELETE FROM stripe_accounts')
    await adapter.query('DELETE FROM stripe__cursors')
  })

  describe('Account Operations', () => {
    it('upserts and retrieves account by API key hash', async () => {
      const account = { id: 'acct_test123', raw_data: { name: 'Test Account' } }
      const apiKeyHash = 'hash_abc123'

      await client.upsertAccount(account, apiKeyHash)

      const retrieved = await client.getAccountByApiKeyHash(apiKeyHash)
      expect(retrieved).toEqual({ name: 'Test Account' })
    })

    it('getAccountIdByApiKeyHash returns correct ID', async () => {
      const account = { id: 'acct_test456', raw_data: { name: 'Another Account' } }
      const apiKeyHash = 'hash_def456'

      await client.upsertAccount(account, apiKeyHash)

      const id = await client.getAccountIdByApiKeyHash(apiKeyHash)
      expect(id).toBe('acct_test456')
    })

    it('returns null for non-existent API key hash', async () => {
      const result = await client.getAccountByApiKeyHash('nonexistent')
      expect(result).toBeNull()
    })

    it('getAllAccounts returns all accounts', async () => {
      await client.upsertAccount({ id: 'acct_1', raw_data: { n: 1 } }, 'h1')
      await client.upsertAccount({ id: 'acct_2', raw_data: { n: 2 } }, 'h2')

      const accounts = await client.getAllAccounts()
      expect(accounts).toHaveLength(2)
    })
  })

  describe('Upsert Operations', () => {
    const accountId = 'acct_test'

    it('upsertManyWithTimestampProtection inserts new records', async () => {
      const customers = [
        { id: 'cus_1', email: 'a@test.com' },
        { id: 'cus_2', email: 'b@test.com' },
      ]

      const result = await client.upsertManyWithTimestampProtection(
        customers, 'customers', accountId
      )
      expect(result).toHaveLength(2)

      const { rows } = await adapter.query('SELECT id FROM stripe_customers ORDER BY id')
      expect(rows.map((r: any) => r.id)).toEqual(['cus_1', 'cus_2'])
    })

    it('upsertManyWithTimestampProtection updates existing records', async () => {
      await client.upsertManyWithTimestampProtection(
        [{ id: 'cus_update', email: 'old@test.com' }], 'customers', accountId
      )
      await client.upsertManyWithTimestampProtection(
        [{ id: 'cus_update', email: 'new@test.com' }], 'customers', accountId
      )

      const { rows } = await adapter.query<{ _raw_data: string }>(
        'SELECT _raw_data FROM stripe_customers WHERE id = ?',
        ['cus_update']
      )
      const data = JSON.parse(rows[0]._raw_data)
      expect(data.email).toBe('new@test.com')
    })

    it('upsertManyWithTimestampProtection handles empty array', async () => {
      const result = await client.upsertManyWithTimestampProtection([], 'customers', accountId)
      expect(result).toEqual([])
    })

    it('upsertManyWithTimestampProtection throws for entries without id', async () => {
      await expect(
        client.upsertManyWithTimestampProtection([{ email: 'no-id@test.com' } as any], 'customers', accountId)
      ).rejects.toThrow('Entry missing id field')
    })
  })

  describe('Timestamp Protection', () => {
    it('upsertManyWithTimestampProtection inserts new records', async () => {
      const customers = [{ id: 'cus_ts1', email: 'ts@test.com' }]
      const result = await client.upsertManyWithTimestampProtection(
        customers,
        'customers',
        'acct_123',
        '2024-01-01T00:00:00Z'
      )
      expect(result).toHaveLength(1)
    })

    it('upsertManyWithTimestampProtection skips older data', async () => {
      // Insert with newer timestamp
      await client.upsertManyWithTimestampProtection(
        [{ id: 'cus_ts2', email: 'new@test.com' }],
        'customers',
        'acct_123',
        '2024-06-01T00:00:00Z'
      )

      // Try to upsert with older timestamp - should be skipped
      const result = await client.upsertManyWithTimestampProtection(
        [{ id: 'cus_ts2', email: 'old@test.com' }],
        'customers',
        'acct_123',
        '2024-01-01T00:00:00Z'
      )
      expect(result).toHaveLength(0)

      // Verify original data unchanged
      const { rows } = await adapter.query<{ _raw_data: string }>(
        'SELECT _raw_data FROM stripe_customers WHERE id = ?',
        ['cus_ts2']
      )
      const data = JSON.parse(rows[0]._raw_data)
      expect(data.email).toBe('new@test.com')
    })

    it('upsertManyWithTimestampProtection updates with newer data', async () => {
      // Insert with older timestamp
      await client.upsertManyWithTimestampProtection(
        [{ id: 'cus_ts3', email: 'old@test.com' }],
        'customers',
        'acct_123',
        '2024-01-01T00:00:00Z'
      )

      // Upsert with newer timestamp - should update
      const result = await client.upsertManyWithTimestampProtection(
        [{ id: 'cus_ts3', email: 'new@test.com' }],
        'customers',
        'acct_123',
        '2024-06-01T00:00:00Z'
      )
      expect(result).toHaveLength(1)

      // Verify data was updated
      const { rows } = await adapter.query<{ _raw_data: string }>(
        'SELECT _raw_data FROM stripe_customers WHERE id = ?',
        ['cus_ts3']
      )
      const data = JSON.parse(rows[0]._raw_data)
      expect(data.email).toBe('new@test.com')
    })
  })

  describe('Cursor Management', () => {
    const accountId = 'acct_cursor_test'
    const runStartedAt = new Date()

    it('updateObjectCursor stores cursor', async () => {
      await client.updateObjectCursor(accountId, runStartedAt, 'customers', 'cursor_123')

      const cursor = await client.getLastCompletedCursor(accountId, 'customers')
      expect(cursor).toBe('cursor_123')
    })

    it('getLastCompletedCursor returns null for non-existent cursor', async () => {
      const cursor = await client.getLastCompletedCursor('nonexistent', 'customers')
      expect(cursor).toBeNull()
    })

    it('page cursor management works', async () => {
      // Set page cursor
      await client.updateObjectPageCursor(accountId, runStartedAt, 'invoices', 'page_xyz')

      // Get object run returns page cursor
      const run = await client.getObjectRun(accountId, runStartedAt, 'invoices')
      expect(run?.pageCursor).toBe('page_xyz')

      // Clear page cursor
      await client.clearObjectPageCursor(accountId, runStartedAt, 'invoices')

      const runAfter = await client.getObjectRun(accountId, runStartedAt, 'invoices')
      expect(runAfter).toBeNull()
    })
  })

  describe('Delete Operations', () => {
    const accountId = 'acct_delete_test'

    it('delete removes record and returns true', async () => {
      await client.upsertManyWithTimestampProtection(
        [{ id: 'cus_delete', email: 'delete@test.com' }], 'customers', accountId
      )

      const deleted = await client.delete('customers', 'cus_delete')
      expect(deleted).toBe(true)

      const { rows } = await adapter.query('SELECT id FROM stripe_customers WHERE id = ?', ['cus_delete'])
      expect(rows).toHaveLength(0)
    })

    it('delete returns false for non-existent record', async () => {
      const deleted = await client.delete('customers', 'nonexistent')
      expect(deleted).toBe(false)
    })
  })

  describe('findMissingEntries', () => {
    const accountId = 'acct_find_test'

    it('returns IDs not in database', async () => {
      await client.upsertManyWithTimestampProtection([
        { id: 'cus_exists1', email: 'a@test.com' },
        { id: 'cus_exists2', email: 'b@test.com' },
      ], 'customers', accountId)

      const missing = await client.findMissingEntries('customers', [
        'cus_exists1',
        'cus_missing1',
        'cus_exists2',
        'cus_missing2',
      ])

      expect(missing.sort()).toEqual(['cus_missing1', 'cus_missing2'])
    })

    it('returns all IDs if none exist', async () => {
      const missing = await client.findMissingEntries('customers', ['cus_a', 'cus_b'])
      expect(missing.sort()).toEqual(['cus_a', 'cus_b'])
    })

    it('returns empty array for empty input', async () => {
      const missing = await client.findMissingEntries('customers', [])
      expect(missing).toEqual([])
    })
  })

  describe('PostgreSQL-only features (no-ops)', () => {
    it('advisory locks are no-ops', async () => {
      await client.acquireAdvisoryLock('test')
      await client.releaseAdvisoryLock('test')
      // Should not throw
    })

    it('withAdvisoryLock executes function without locking', async () => {
      const result = await client.withAdvisoryLock('test', async () => 'done')
      expect(result).toBe('done')
    })

    it('getOrCreateSyncRun returns stub', async () => {
      const run = await client.getOrCreateSyncRun('acct_123')
      expect(run.accountId).toBe('acct_123')
      expect(run.isNew).toBe(true)
    })

    it('sync observability methods are no-ops', async () => {
      // These should not throw
      await client.closeSyncRun('acct', new Date())
      await client.createObjectRuns('acct', new Date(), ['customers'])
      await client.incrementObjectProgress('acct', new Date(), 'customers', 10)
      await client.failObjectSync('acct', new Date(), 'customers', 'error')
      await client.deleteSyncRuns('acct')
      await client.cancelStaleRuns('acct')

      expect(await client.getActiveSyncRun('acct')).toBeNull()
      expect(await client.getSyncRun('acct', new Date())).toBeNull()
      expect(await client.tryStartObjectSync('acct', new Date(), 'customers')).toBe(true)
      expect(await client.hasAnyObjectErrors('acct', new Date())).toBe(false)
      expect(await client.countRunningObjects('acct', new Date())).toBe(0)
      expect(await client.getNextPendingObject('acct', new Date())).toBeNull()
      expect(await client.areAllObjectsComplete('acct', new Date())).toBe(true)
    })
  })
})
