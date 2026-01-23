/**
 * @module BaseSyncClient
 *
 * Base sync client that implements common database operations.
 * This class provides a unified implementation for all non-PostgreSQL databases
 * (DuckDB, SQLite, MySQL) using the adapter pattern.
 *
 * Key features:
 * - Automatic placeholder conversion ($1 vs ? based on database type)
 * - Timestamp formatting (ISO 8601 vs MySQL datetime format)
 * - Upsert operations with timestamp protection
 * - Cursor management for incremental syncs
 *
 * PostgreSQL-specific features (advisory locks, sync observability) are
 * implemented as no-ops here since they're only available in PostgresClient.
 *
 * @example
 * ```typescript
 * import { createSyncClient } from './createSyncClient'
 *
 * const client = createSyncClient({ type: 'sqlite', url: './stripe.sqlite' })
 * await client.migrate()
 * await client.upsertManyWithTimestampProtection(customers, 'customers', accountId)
 * ```
 */

import type { DatabaseAdapter } from './adapters/types.js'
import { getTableName, migrateSchema } from './schema.js'
import type { SyncDatabaseClient } from './SyncDatabaseClient.js'
import type { RawJsonUpsertOptions } from './postgres.js'

/**
 * Convert placeholders from $1, $2 style to ? style if needed
 */
function convertPlaceholders(sql: string, useQuestionMark: boolean): string {
  if (!useQuestionMark) return sql
  return sql.replace(/\$(\d+)/g, '?')
}

/**
 * Format timestamp for the database
 * MySQL requires 'YYYY-MM-DD HH:MM:SS.sss' format
 * Others accept ISO 8601
 */
function formatTimestamp(isoTimestamp: string, dbType: string): string {
  if (dbType === 'mysql') {
    return new Date(isoTimestamp).toISOString().slice(0, 23).replace('T', ' ')
  }
  return isoTimestamp
}

/**
 * Base implementation of SyncDatabaseClient.
 * Handles all common operations using the database adapter.
 */
export class BaseSyncClient implements SyncDatabaseClient {
  protected connected = false
  protected readonly useQuestionMarkPlaceholders: boolean
  protected readonly dbType: string

  constructor(protected adapter: DatabaseAdapter) {
    this.dbType = adapter.type
    // MySQL and SQLite use ? placeholders, PostgreSQL and DuckDB use $1, $2
    this.useQuestionMarkPlaceholders = adapter.type === 'mysql' || adapter.type === 'sqlite'
  }

  async connect(): Promise<void> {
    if (this.connected) return
    await this.adapter.connect()
    this.connected = true
  }

  async close(): Promise<void> {
    if (this.connected) {
      await this.adapter.close()
      this.connected = false
    }
  }

  /**
   * Initialize the database schema
   */
  async migrate(): Promise<void> {
    await migrateSchema(this.adapter)
    this.connected = true
  }

  /**
   * Execute a raw query with automatic placeholder conversion
   */
  async query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }> {
    await this.connect()
    const sql = convertPlaceholders(text, this.useQuestionMarkPlaceholders)
    const result = await this.adapter.query(sql, params)
    return { rows: result.rows, rowCount: result.rowCount }
  }

  /**
   * Delete a record by ID
   */
  async delete(table: string, id: string): Promise<boolean> {
    await this.connect()
    const tableName = getTableName(table)
    const sql = convertPlaceholders(
      `DELETE FROM ${tableName} WHERE id = $1`,
      this.useQuestionMarkPlaceholders
    )
    const result = await this.adapter.query(sql, [id])
    return result.rowCount > 0
  }

  /**
   * Upsert multiple entries with timestamp protection
   */
  async upsertManyWithTimestampProtection<T extends Record<string, any>>(
    entries: T[],
    table: string,
    accountId: string,
    syncTimestamp?: string,
    _upsertOptions?: RawJsonUpsertOptions
  ): Promise<T[]> {
    if (!entries.length) return []

    await this.connect()
    const tableName = getTableName(table)
    const timestamp = formatTimestamp(
      syncTimestamp || new Date().toISOString(),
      this.dbType
    )
    const results: T[] = []

    for (const entry of entries) {
      const id = entry.id
      if (!id) {
        throw new Error(`Entry missing id field for table ${table}`)
      }

      const rawData = JSON.stringify(entry)

      // Check if newer data exists
      const selectSql = convertPlaceholders(
        `SELECT _last_synced_at FROM ${tableName} WHERE id = $1`,
        this.useQuestionMarkPlaceholders
      )
      const existingResult = await this.adapter.query<{ _last_synced_at: string }>(
        selectSql,
        [id]
      )

      const existingTimestamp = existingResult.rows[0]?._last_synced_at
      if (existingTimestamp) {
        const existingDate = new Date(existingTimestamp)
        const newDate = new Date(syncTimestamp || timestamp)
        if (existingDate > newDate) {
          continue // Skip - existing data is newer
        }
      }

      // Perform upsert
      const upsertSql = this.buildUpsertSql(tableName, true)
      await this.adapter.query(upsertSql, [id, rawData, accountId, timestamp])

      results.push(entry)
    }

    return results
  }

  /**
   * Simple upsert without timestamp protection
   */
  async upsertMany<T extends Record<string, any>>(
    entries: T[],
    table: string
  ): Promise<T[]> {
    if (!entries.length) return []

    await this.connect()
    const tableName = getTableName(table)
    const results: T[] = []
    const now = formatTimestamp(new Date().toISOString(), this.dbType)

    for (const entry of entries) {
      const id = entry.id
      if (!id) {
        throw new Error(`Entry missing id field for table ${table}`)
      }

      const rawData = JSON.stringify(entry)
      const upsertSql = this.buildUpsertSql(tableName, false)
      await this.adapter.query(upsertSql, [id, rawData, now])

      results.push(entry)
    }

    return results
  }

  /**
   * Find entries that don't exist in the database
   */
  async findMissingEntries(table: string, ids: string[]): Promise<string[]> {
    if (!ids.length) return []

    await this.connect()
    const tableName = getTableName(table)

    // Build placeholders based on dialect
    const placeholders = this.useQuestionMarkPlaceholders
      ? ids.map(() => '?').join(', ')
      : ids.map((_, i) => `$${i + 1}`).join(', ')

    const sql = `SELECT id FROM ${tableName} WHERE id IN (${placeholders})`
    const result = await this.adapter.query<{ id: string }>(sql, ids)

    const existingIds = new Set(result.rows.map(r => r.id))
    return ids.filter(id => !existingIds.has(id))
  }

  /**
   * Upsert account information
   */
  async upsertAccount(
    account: { id: string; raw_data: any },
    apiKeyHash: string
  ): Promise<void> {
    await this.connect()

    const rawData = JSON.stringify(account.raw_data)
    const now = formatTimestamp(new Date().toISOString(), this.dbType)
    const sql = this.buildAccountUpsertSql()

    await this.adapter.query(sql, [account.id, rawData, apiKeyHash, now])
  }

  /**
   * Get account by API key hash
   */
  async getAccountByApiKeyHash(apiKeyHash: string): Promise<any | null> {
    await this.connect()

    const sql = convertPlaceholders(
      `SELECT _raw_data FROM stripe_accounts WHERE _api_key_hash = $1`,
      this.useQuestionMarkPlaceholders
    )
    const result = await this.adapter.query<{ _raw_data: string | object }>(sql, [apiKeyHash])

    if (result.rows.length === 0) return null
    const rawData = result.rows[0]._raw_data
    return typeof rawData === 'string' ? JSON.parse(rawData) : rawData
  }

  /**
   * Get account ID by API key hash
   */
  async getAccountIdByApiKeyHash(apiKeyHash: string): Promise<string | null> {
    await this.connect()

    const sql = convertPlaceholders(
      `SELECT id FROM stripe_accounts WHERE _api_key_hash = $1`,
      this.useQuestionMarkPlaceholders
    )
    const result = await this.adapter.query<{ id: string }>(sql, [apiKeyHash])

    return result.rows[0]?.id ?? null
  }

  /**
   * Get all accounts
   */
  async getAllAccounts(): Promise<any[]> {
    await this.connect()

    const result = await this.adapter.query<{ _raw_data: string | object }>(
      `SELECT _raw_data FROM stripe_accounts`
    )

    return result.rows.map(r => {
      const rawData = r._raw_data
      return typeof rawData === 'string' ? JSON.parse(rawData) : rawData
    })
  }

  /**
   * Update cursor for an object type
   */
  async updateObjectCursor(
    accountId: string,
    _runStartedAt: Date,
    objectType: string,
    cursor: string | null
  ): Promise<void> {
    await this.connect()
    const now = formatTimestamp(new Date().toISOString(), this.dbType)
    const sql = this.buildCursorUpsertSql()

    await this.adapter.query(sql, [accountId, objectType, cursor, now])
  }

  /**
   * Get last completed cursor for an object type
   */
  async getLastCompletedCursor(accountId: string, objectType: string): Promise<string | null> {
    await this.connect()

    const sql = convertPlaceholders(
      `SELECT cursor_value FROM stripe__cursors WHERE account_id = $1 AND object_type = $2`,
      this.useQuestionMarkPlaceholders
    )
    const result = await this.adapter.query<{ cursor_value: string }>(sql, [accountId, objectType])

    return result.rows[0]?.cursor_value ?? null
  }

  // ========================================================================
  // Pagination cursor methods (required for processNext to work correctly)
  // ========================================================================

  async getObjectRun(accountId: string, _runStartedAt: Date, object: string): Promise<any> {
    await this.connect()

    const pageCursorKey = `${object}_page_cursor`
    const sql = convertPlaceholders(
      `SELECT cursor_value FROM stripe__cursors WHERE account_id = $1 AND object_type = $2`,
      this.useQuestionMarkPlaceholders
    )
    const result = await this.adapter.query<{ cursor_value: string }>(
      sql,
      [accountId, pageCursorKey]
    )

    if (result.rows.length === 0) {
      return null
    }

    return {
      pageCursor: result.rows[0].cursor_value,
      status: 'running',
    }
  }

  async updateObjectPageCursor(
    accountId: string,
    _runStartedAt: Date,
    object: string,
    cursor: string | null
  ): Promise<void> {
    await this.connect()
    const pageCursorKey = `${object}_page_cursor`
    const now = formatTimestamp(new Date().toISOString(), this.dbType)

    if (cursor === null) {
      const deleteSql = convertPlaceholders(
        `DELETE FROM stripe__cursors WHERE account_id = $1 AND object_type = $2`,
        this.useQuestionMarkPlaceholders
      )
      await this.adapter.query(deleteSql, [accountId, pageCursorKey])
    } else {
      const upsertSql = this.buildCursorUpsertSql()
      await this.adapter.query(upsertSql, [accountId, pageCursorKey, cursor, now])
    }
  }

  async clearObjectPageCursor(
    accountId: string,
    _runStartedAt: Date,
    object: string
  ): Promise<void> {
    await this.connect()
    const pageCursorKey = `${object}_page_cursor`
    const sql = convertPlaceholders(
      `DELETE FROM stripe__cursors WHERE account_id = $1 AND object_type = $2`,
      this.useQuestionMarkPlaceholders
    )
    await this.adapter.query(sql, [accountId, pageCursorKey])
  }

  // ========================================================================
  // Sync observability features - NOT SUPPORTED in non-PostgreSQL databases
  // These methods are no-ops or return sensible defaults
  // ========================================================================

  async acquireAdvisoryLock(_key: string): Promise<void> {}
  async releaseAdvisoryLock(_key: string): Promise<void> {}

  async withAdvisoryLock<T>(_key: string, fn: () => Promise<T>): Promise<T> {
    return fn()
  }

  async getOrCreateSyncRun(accountId: string, _triggeredBy?: string): Promise<any> {
    return { accountId, runStartedAt: new Date(), isNew: true }
  }

  async getActiveSyncRun(_accountId: string): Promise<any> {
    return null
  }

  async getSyncRun(_accountId: string, _runStartedAt: Date): Promise<any> {
    return null
  }

  async closeSyncRun(_accountId: string, _runStartedAt: Date): Promise<void> {}

  async createObjectRuns(_accountId: string, _runStartedAt: Date, _objects: string[]): Promise<void> {}

  async tryStartObjectSync(_accountId: string, _runStartedAt: Date, _object: string): Promise<boolean> {
    return true
  }

  async incrementObjectProgress(
    _accountId: string,
    _runStartedAt: Date,
    _object: string,
    _count: number
  ): Promise<void> {}

  async getLastCursorBeforeRun(
    _accountId: string,
    _object: string,
    _runStartedAt: Date
  ): Promise<string | null> {
    return null
  }

  async deleteSyncRuns(_accountId: string): Promise<void> {}

  async completeObjectSync(accountId: string, runStartedAt: Date, object: string): Promise<void> {
    await this.clearObjectPageCursor(accountId, runStartedAt, object)
  }

  async failObjectSync(
    _accountId: string,
    _runStartedAt: Date,
    _object: string,
    _error: string
  ): Promise<void> {}

  async hasAnyObjectErrors(_accountId: string, _runStartedAt: Date): Promise<boolean> {
    return false
  }

  async countRunningObjects(_accountId: string, _runStartedAt: Date): Promise<number> {
    return 0
  }

  async getNextPendingObject(_accountId: string, _runStartedAt: Date): Promise<string | null> {
    return null
  }

  async areAllObjectsComplete(_accountId: string, _runStartedAt: Date): Promise<boolean> {
    return true
  }

  async cancelStaleRuns(_accountId: string): Promise<void> {}

  async deleteAccountWithCascade(
    _accountId: string,
    _useTransaction: boolean
  ): Promise<{ [tableName: string]: number }> {
    throw new Error('deleteAccountWithCascade not implemented for this database type')
  }

  async getAccountRecordCounts(_accountId: string): Promise<{ [tableName: string]: number }> {
    return {}
  }

  get pool() {
    return {
      query: this.query.bind(this),
      end: this.close.bind(this),
    }
  }

  // ========================================================================
  // SQL builders - handle dialect differences
  // ========================================================================

  /**
   * Build upsert SQL for entity tables
   */
  protected buildUpsertSql(tableName: string, includeAccountId: boolean): string {
    if (this.dbType === 'mysql') {
      if (includeAccountId) {
        return `INSERT INTO ${tableName} (id, _raw_data, _account_id, _last_synced_at)
                VALUES (?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                  _raw_data = VALUES(_raw_data),
                  _account_id = VALUES(_account_id),
                  _last_synced_at = VALUES(_last_synced_at)`
      }
      return `INSERT INTO ${tableName} (id, _raw_data, _last_synced_at)
              VALUES (?, ?, ?)
              ON DUPLICATE KEY UPDATE
                _raw_data = VALUES(_raw_data),
                _last_synced_at = VALUES(_last_synced_at)`
    }

    // PostgreSQL, DuckDB, SQLite use ON CONFLICT with EXCLUDED
    const p = (n: number) => this.useQuestionMarkPlaceholders ? '?' : `$${n}`

    if (includeAccountId) {
      return `INSERT INTO ${tableName} (id, _raw_data, _account_id, _last_synced_at)
              VALUES (${p(1)}, ${p(2)}, ${p(3)}, ${p(4)})
              ON CONFLICT (id) DO UPDATE SET
                _raw_data = EXCLUDED._raw_data,
                _account_id = EXCLUDED._account_id,
                _last_synced_at = EXCLUDED._last_synced_at`
    }
    return `INSERT INTO ${tableName} (id, _raw_data, _last_synced_at)
            VALUES (${p(1)}, ${p(2)}, ${p(3)})
            ON CONFLICT (id) DO UPDATE SET
              _raw_data = EXCLUDED._raw_data,
              _last_synced_at = EXCLUDED._last_synced_at`
  }

  /**
   * Build upsert SQL for accounts table
   */
  protected buildAccountUpsertSql(): string {
    if (this.dbType === 'mysql') {
      return `INSERT INTO stripe_accounts (id, _raw_data, _api_key_hash, _last_synced_at)
              VALUES (?, ?, ?, ?)
              ON DUPLICATE KEY UPDATE
                _raw_data = VALUES(_raw_data),
                _api_key_hash = VALUES(_api_key_hash),
                _last_synced_at = VALUES(_last_synced_at)`
    }

    const p = (n: number) => this.useQuestionMarkPlaceholders ? '?' : `$${n}`
    return `INSERT INTO stripe_accounts (id, _raw_data, _api_key_hash, _last_synced_at)
            VALUES (${p(1)}, ${p(2)}, ${p(3)}, ${p(4)})
            ON CONFLICT (id) DO UPDATE SET
              _raw_data = EXCLUDED._raw_data,
              _api_key_hash = EXCLUDED._api_key_hash,
              _last_synced_at = EXCLUDED._last_synced_at`
  }

  /**
   * Build upsert SQL for cursors table
   */
  protected buildCursorUpsertSql(): string {
    if (this.dbType === 'mysql') {
      return `INSERT INTO stripe__cursors (account_id, object_type, cursor_value, updated_at)
              VALUES (?, ?, ?, ?)
              ON DUPLICATE KEY UPDATE
                cursor_value = VALUES(cursor_value),
                updated_at = VALUES(updated_at)`
    }

    const p = (n: number) => this.useQuestionMarkPlaceholders ? '?' : `$${n}`
    return `INSERT INTO stripe__cursors (account_id, object_type, cursor_value, updated_at)
            VALUES (${p(1)}, ${p(2)}, ${p(3)}, ${p(4)})
            ON CONFLICT (account_id, object_type) DO UPDATE SET
              cursor_value = EXCLUDED.cursor_value,
              updated_at = EXCLUDED.updated_at`
  }
}
