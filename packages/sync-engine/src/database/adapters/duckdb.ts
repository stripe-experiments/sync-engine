import duckdb from 'duckdb'
import type { DatabaseAdapter, QueryResult, DuckDBAdapterConfig } from './types.js'
import { duckdbDialect, DuckDBDialect } from '../dialect/duckdb.js'

/**
 * DuckDB database adapter
 */
export class DuckDBAdapter implements DatabaseAdapter {
  readonly type = 'duckdb' as const
  readonly dialect: DuckDBDialect = duckdbDialect
  readonly supportsReturning = true
  readonly supportsJsonb = false
  readonly supportsArrays = true
  readonly supportsSchemas = true

  private db: duckdb.Database | null = null
  private connection: duckdb.Connection | null = null
  private inTransaction = false
  private config: DuckDBAdapterConfig

  constructor(config: DuckDBAdapterConfig) {
    this.config = config
  }

  async connect(): Promise<void> {
    if (this.db) {
      return // Already connected
    }

    return new Promise((resolve, reject) => {
      const isMemory = this.config.url === ':memory:' || this.config.options?.memory
      const dbPath = isMemory ? ':memory:' : this.config.url

      const accessMode = this.config.options?.readonly
        ? duckdb.OPEN_READONLY
        : duckdb.OPEN_READWRITE | duckdb.OPEN_CREATE

      this.db = new duckdb.Database(dbPath, accessMode, (err) => {
        if (err) {
          reject(err)
          return
        }

        this.connection = this.db!.connect()
        resolve()
      })
    })
  }

  async close(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.connection) {
        this.connection.close((err) => {
          if (err) {
            reject(err)
            return
          }
          this.connection = null

          if (this.db) {
            this.db.close((err) => {
              if (err) {
                reject(err)
                return
              }
              this.db = null
              resolve()
            })
          } else {
            resolve()
          }
        })
      } else if (this.db) {
        this.db.close((err) => {
          if (err) {
            reject(err)
            return
          }
          this.db = null
          resolve()
        })
      } else {
        resolve()
      }
    })
  }

  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    this.ensureConnected()

    return new Promise((resolve, reject) => {
      // DuckDB uses $1, $2 placeholders but the API takes an array
      // We need to handle the parameter binding appropriately

      if (params && params.length > 0) {
        // Use prepared statement for parameterized queries
        const stmt = this.connection!.prepare(sql, (err, prepared) => {
          if (err) {
            reject(new Error(`DuckDB prepare failed: ${err.message}\nSQL: ${sql}`))
            return
          }

          prepared.all(...params, (err: Error | null, rows: T[]) => {
            prepared.finalize()

            if (err) {
              reject(new Error(`DuckDB query failed: ${err.message}\nSQL: ${sql}\nParams: ${JSON.stringify(params)}`))
              return
            }

            resolve({
              rows: rows || [],
              rowCount: rows?.length || 0,
            })
          })
        })
      } else {
        // No parameters, use simple all() method
        this.connection!.all(sql, (err: Error | null, rows: T[]) => {
          if (err) {
            reject(new Error(`DuckDB query failed: ${err.message}\nSQL: ${sql}`))
            return
          }

          resolve({
            rows: rows || [],
            rowCount: rows?.length || 0,
          })
        })
      }
    })
  }

  async beginTransaction(): Promise<void> {
    this.ensureConnected()

    if (this.inTransaction) {
      throw new Error('Transaction already in progress')
    }

    await this.query('BEGIN TRANSACTION')
    this.inTransaction = true
  }

  async commit(): Promise<void> {
    if (!this.inTransaction) {
      throw new Error('No transaction in progress')
    }

    await this.query('COMMIT')
    this.inTransaction = false
  }

  async rollback(): Promise<void> {
    if (!this.inTransaction) {
      throw new Error('No transaction in progress')
    }

    await this.query('ROLLBACK')
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
   * Get the underlying DuckDB Database instance for advanced operations
   */
  getDatabase(): duckdb.Database {
    this.ensureConnected()
    return this.db!
  }

  /**
   * Get the underlying DuckDB Connection for advanced operations
   */
  getConnection(): duckdb.Connection {
    this.ensureConnected()
    return this.connection!
  }

  private ensureConnected(): void {
    if (!this.db || !this.connection) {
      throw new Error('Database not connected. Call connect() first.')
    }
  }
}

/**
 * Create a DuckDB adapter from a file path or :memory:
 */
export function createDuckDBAdapter(url: string, options?: DuckDBAdapterConfig['options']): DuckDBAdapter {
  return new DuckDBAdapter({
    type: 'duckdb',
    url,
    options,
  })
}
