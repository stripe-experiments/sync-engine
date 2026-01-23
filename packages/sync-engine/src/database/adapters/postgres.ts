import pg from 'pg'
import type { DatabaseAdapter, QueryResult, PostgresAdapterConfig } from './types.js'
import { postgresDialect, PostgresDialect } from '../dialect/postgres.js'

/**
 * PostgreSQL database adapter using node-postgres (pg)
 */
export class PostgresAdapter implements DatabaseAdapter {
  readonly type = 'postgres' as const
  readonly dialect: PostgresDialect = postgresDialect
  readonly supportsReturning = true
  readonly supportsJsonb = true
  readonly supportsArrays = true
  readonly supportsSchemas = true

  private pool: pg.Pool | null = null
  private transactionClient: pg.PoolClient | null = null
  private config: PostgresAdapterConfig

  constructor(config: PostgresAdapterConfig) {
    this.config = config
  }

  async connect(): Promise<void> {
    if (this.pool) {
      return // Already connected
    }

    const poolConfig: pg.PoolConfig = {
      connectionString: this.config.url,
      max: this.config.options?.max ?? 10,
      connectionTimeoutMillis: this.config.options?.connectionTimeoutMs,
      idleTimeoutMillis: this.config.options?.idleTimeoutMs,
    }

    // Handle SSL configuration
    if (this.config.options?.ssl !== undefined) {
      if (typeof this.config.options.ssl === 'boolean') {
        poolConfig.ssl = this.config.options.ssl ? { rejectUnauthorized: false } : false
      } else {
        poolConfig.ssl = this.config.options.ssl
      }
    }

    this.pool = new pg.Pool(poolConfig)

    // Test the connection
    const client = await this.pool.connect()
    client.release()
  }

  async close(): Promise<void> {
    if (this.transactionClient) {
      this.transactionClient.release()
      this.transactionClient = null
    }
    if (this.pool) {
      await this.pool.end()
      this.pool = null
    }
  }

  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    this.ensureConnected()

    // Use transaction client if in a transaction, otherwise use pool
    const client = this.transactionClient || this.pool!

    const result = await client.query(sql, params)

    return {
      rows: result.rows as T[],
      rowCount: result.rowCount ?? 0,
    }
  }

  async beginTransaction(): Promise<void> {
    this.ensureConnected()

    if (this.transactionClient) {
      throw new Error('Transaction already in progress')
    }

    this.transactionClient = await this.pool!.connect()
    await this.transactionClient.query('BEGIN')
  }

  async commit(): Promise<void> {
    if (!this.transactionClient) {
      throw new Error('No transaction in progress')
    }

    try {
      await this.transactionClient.query('COMMIT')
    } finally {
      this.transactionClient.release()
      this.transactionClient = null
    }
  }

  async rollback(): Promise<void> {
    if (!this.transactionClient) {
      throw new Error('No transaction in progress')
    }

    try {
      await this.transactionClient.query('ROLLBACK')
    } finally {
      this.transactionClient.release()
      this.transactionClient = null
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
   * Get the underlying pg.Pool for advanced operations
   * (e.g., advisory locks, which require connection-level state)
   */
  getPool(): pg.Pool {
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
 * Create a PostgreSQL adapter from a connection URL
 */
export function createPostgresAdapter(url: string, options?: PostgresAdapterConfig['options']): PostgresAdapter {
  return new PostgresAdapter({
    type: 'postgres',
    url,
    options,
  })
}
