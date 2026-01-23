import Database from 'better-sqlite3'
import type { DatabaseAdapter, QueryResult, SQLiteAdapterConfig } from './types.js'
import { sqliteDialect, SQLiteDialect } from '../dialect/sqlite.js'

/**
 * SQLite database adapter using better-sqlite3
 */
export class SQLiteAdapter implements DatabaseAdapter {
  readonly type = 'sqlite' as const
  readonly dialect: SQLiteDialect = sqliteDialect
  readonly supportsReturning = false
  readonly supportsJsonb = false
  readonly supportsArrays = false
  readonly supportsSchemas = false

  private db: Database.Database | null = null
  private inTransaction = false
  private config: SQLiteAdapterConfig

  constructor(config: SQLiteAdapterConfig) {
    this.config = config
  }

  async connect(): Promise<void> {
    if (this.db) {
      return // Already connected
    }

    const isMemory = this.config.url === ':memory:' || this.config.options?.memory

    this.db = new Database(isMemory ? ':memory:' : this.config.url, {
      readonly: this.config.options?.readonly ?? false,
    })

    // Enable foreign keys (disabled by default in SQLite)
    this.db.pragma('foreign_keys = ON')

    // Enable WAL mode for better concurrent read performance
    if (!this.config.options?.readonly && !isMemory) {
      this.db.pragma('journal_mode = WAL')
    }
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close()
      this.db = null
    }
  }

  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    this.ensureConnected()

    const trimmedSql = sql.trim().toUpperCase()
    const isSelect = trimmedSql.startsWith('SELECT')
    const isInsert = trimmedSql.startsWith('INSERT')
    const isUpdate = trimmedSql.startsWith('UPDATE')
    const isDelete = trimmedSql.startsWith('DELETE')

    try {
      if (isSelect) {
        const stmt = this.db!.prepare(sql)
        const rows = params ? stmt.all(...params) : stmt.all()
        return {
          rows: rows as T[],
          rowCount: rows.length,
        }
      } else {
        const stmt = this.db!.prepare(sql)
        const result = params ? stmt.run(...params) : stmt.run()

        // For INSERT/UPDATE/DELETE, return changes count
        return {
          rows: [] as T[],
          rowCount: result.changes,
        }
      }
    } catch (error) {
      // Re-throw with more context
      const err = error as Error
      throw new Error(`SQLite query failed: ${err.message}\nSQL: ${sql}\nParams: ${JSON.stringify(params)}`)
    }
  }

  async beginTransaction(): Promise<void> {
    this.ensureConnected()

    if (this.inTransaction) {
      throw new Error('Transaction already in progress')
    }

    this.db!.exec('BEGIN')
    this.inTransaction = true
  }

  async commit(): Promise<void> {
    if (!this.inTransaction) {
      throw new Error('No transaction in progress')
    }

    this.db!.exec('COMMIT')
    this.inTransaction = false
  }

  async rollback(): Promise<void> {
    if (!this.inTransaction) {
      throw new Error('No transaction in progress')
    }

    this.db!.exec('ROLLBACK')
    this.inTransaction = false
  }

  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    await this.beginTransaction()

    try {
      const result = await fn()
      await this.commit()
      return result
    } catch (error) {
      await this.rollback()
      throw error
    }
  }

  /**
   * Get the last inserted row ID
   * SQLite doesn't support RETURNING, so we need this for insert operations
   */
  async getLastInsertId(): Promise<number | null> {
    this.ensureConnected()

    const stmt = this.db!.prepare('SELECT last_insert_rowid() as id')
    const result = stmt.get() as { id: number } | undefined

    return result?.id ?? null
  }

  /**
   * Get the underlying better-sqlite3 Database instance for advanced operations
   */
  getDatabase(): Database.Database {
    this.ensureConnected()
    return this.db!
  }

  private ensureConnected(): void {
    if (!this.db) {
      throw new Error('Database not connected. Call connect() first.')
    }
  }
}

/**
 * Create a SQLite adapter from a file path or :memory:
 */
export function createSQLiteAdapter(url: string, options?: SQLiteAdapterConfig['options']): SQLiteAdapter {
  return new SQLiteAdapter({
    type: 'sqlite',
    url,
    options,
  })
}
