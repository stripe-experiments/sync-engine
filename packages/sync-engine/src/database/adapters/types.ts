import type { SQLDialect } from '../dialect/types.js'

/**
 * Result of a database query
 */
export interface QueryResult<T = Record<string, unknown>> {
  rows: T[]
  rowCount: number
}

/**
 * Database adapter interface - abstracts database operations across different backends
 */
export interface DatabaseAdapter {
  /** The SQL dialect for this adapter */
  readonly dialect: SQLDialect

  /** Whether this database supports RETURNING clauses */
  readonly supportsReturning: boolean

  /** Whether this database supports native JSONB type */
  readonly supportsJsonb: boolean

  /** Whether this database supports native array types */
  readonly supportsArrays: boolean

  /** Whether this database supports schemas */
  readonly supportsSchemas: boolean

  /** The database type identifier */
  readonly type: DatabaseType

  /**
   * Connect to the database
   */
  connect(): Promise<void>

  /**
   * Close the database connection
   */
  close(): Promise<void>

  /**
   * Execute a SQL query with parameters
   * Parameters use dialect-specific placeholders ($1, ?, etc.)
   */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>

  /**
   * Begin a transaction
   */
  beginTransaction(): Promise<void>

  /**
   * Commit the current transaction
   */
  commit(): Promise<void>

  /**
   * Rollback the current transaction
   */
  rollback(): Promise<void>

  /**
   * Execute a function within a transaction
   * Automatically commits on success, rolls back on error
   */
  withTransaction<T>(fn: () => Promise<T>): Promise<T>

  /**
   * Get the last inserted row ID (for databases without RETURNING support)
   */
  getLastInsertId?(): Promise<string | number | null>
}

/**
 * Supported database types
 */
export type DatabaseType = 'postgres' | 'mysql' | 'sqlite' | 'duckdb'

/**
 * Configuration for creating a database adapter
 */
export interface AdapterConfig {
  /** Database type */
  type: DatabaseType

  /** Connection URL or path */
  url: string

  /** Additional options specific to the database type */
  options?: Record<string, unknown>
}

/**
 * PostgreSQL-specific configuration
 */
export interface PostgresAdapterConfig extends AdapterConfig {
  type: 'postgres'
  options?: {
    /** Maximum pool size */
    max?: number
    /** Connection timeout in ms */
    connectionTimeoutMs?: number
    /** Idle timeout in ms */
    idleTimeoutMs?: number
    /** SSL configuration */
    ssl?: boolean | Record<string, unknown>
  }
}

/**
 * MySQL-specific configuration
 */
export interface MySQLAdapterConfig extends AdapterConfig {
  type: 'mysql'
  options?: {
    /** Maximum pool size */
    connectionLimit?: number
    /** Connection timeout in ms */
    connectTimeout?: number
  }
}

/**
 * SQLite-specific configuration
 */
export interface SQLiteAdapterConfig extends AdapterConfig {
  type: 'sqlite'
  options?: {
    /** Use in-memory database */
    memory?: boolean
    /** Read-only mode */
    readonly?: boolean
  }
}

/**
 * DuckDB-specific configuration
 */
export interface DuckDBAdapterConfig extends AdapterConfig {
  type: 'duckdb'
  options?: {
    /** Use in-memory database */
    memory?: boolean
    /** Read-only mode */
    readonly?: boolean
  }
}

/**
 * Union type of all adapter configurations
 */
export type AnyAdapterConfig =
  | PostgresAdapterConfig
  | MySQLAdapterConfig
  | SQLiteAdapterConfig
  | DuckDBAdapterConfig
