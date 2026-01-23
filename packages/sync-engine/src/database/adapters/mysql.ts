import mysql from 'mysql2/promise'
import type { DatabaseAdapter, QueryResult, MySQLAdapterConfig } from './types.js'
import { mysqlDialect, MySQLDialect } from '../dialect/mysql.js'

/**
 * MySQL database adapter using mysql2
 */
export class MySQLAdapter implements DatabaseAdapter {
  readonly type = 'mysql' as const
  readonly dialect: MySQLDialect = mysqlDialect
  readonly supportsReturning = false
  readonly supportsJsonb = false
  readonly supportsArrays = false
  readonly supportsSchemas = true

  private pool: mysql.Pool | null = null
  private transactionConnection: mysql.PoolConnection | null = null
  private config: MySQLAdapterConfig

  constructor(config: MySQLAdapterConfig) {
    this.config = config
  }

  async connect(): Promise<void> {
    if (this.pool) {
      return // Already connected
    }

    // Parse connection URL
    const url = new URL(this.config.url)

    this.pool = mysql.createPool({
      host: url.hostname,
      port: parseInt(url.port) || 3306,
      user: url.username,
      password: url.password,
      database: url.pathname.slice(1), // Remove leading /
      connectionLimit: this.config.options?.connectionLimit ?? 10,
      connectTimeout: this.config.options?.connectTimeout,
      // Enable JSON parsing
      typeCast: (field, next) => {
        if (field.type === 'JSON') {
          const value = field.string()
          return value ? JSON.parse(value) : null
        }
        return next()
      },
    })

    // Test the connection
    const connection = await this.pool.getConnection()
    connection.release()
  }

  async close(): Promise<void> {
    if (this.transactionConnection) {
      this.transactionConnection.release()
      this.transactionConnection = null
    }
    if (this.pool) {
      await this.pool.end()
      this.pool = null
    }
  }

  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    this.ensureConnected()

    // Use transaction connection if in a transaction, otherwise use pool
    const connection = this.transactionConnection || this.pool!

    const [rows, fields] = await connection.execute(sql, params)

    // Handle SELECT vs INSERT/UPDATE/DELETE results
    if (Array.isArray(rows)) {
      return {
        rows: rows as T[],
        rowCount: rows.length,
      }
    } else {
      // ResultSetHeader for INSERT/UPDATE/DELETE
      const result = rows as mysql.ResultSetHeader
      return {
        rows: [] as T[],
        rowCount: result.affectedRows,
      }
    }
  }

  async beginTransaction(): Promise<void> {
    this.ensureConnected()

    if (this.transactionConnection) {
      throw new Error('Transaction already in progress')
    }

    this.transactionConnection = await this.pool!.getConnection()
    await this.transactionConnection.beginTransaction()
  }

  async commit(): Promise<void> {
    if (!this.transactionConnection) {
      throw new Error('No transaction in progress')
    }

    try {
      await this.transactionConnection.commit()
    } finally {
      this.transactionConnection.release()
      this.transactionConnection = null
    }
  }

  async rollback(): Promise<void> {
    if (!this.transactionConnection) {
      throw new Error('No transaction in progress')
    }

    try {
      await this.transactionConnection.rollback()
    } finally {
      this.transactionConnection.release()
      this.transactionConnection = null
    }
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
   * MySQL doesn't support RETURNING, so we need this for insert operations
   */
  async getLastInsertId(): Promise<number | null> {
    const result = await this.query<{ id: number }>('SELECT LAST_INSERT_ID() as id')
    return result.rows[0]?.id ?? null
  }

  /**
   * Get the underlying mysql2 Pool for advanced operations
   */
  getPool(): mysql.Pool {
    this.ensureConnected()
    return this.pool!
  }

  private ensureConnected(): void {
    if (!this.pool) {
      throw new Error('Database not connected. Call connect() first.')
    }
  }
}

/**
 * Create a MySQL adapter from a connection URL
 */
export function createMySQLAdapter(url: string, options?: MySQLAdapterConfig['options']): MySQLAdapter {
  return new MySQLAdapter({
    type: 'mysql',
    url,
    options,
  })
}
