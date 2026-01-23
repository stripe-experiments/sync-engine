/**
 * Factory function to create database sync clients.
 * Replaces manual if/else chains with a single function call.
 */

import type { DatabaseType, SyncDatabaseClient } from './SyncDatabaseClient.js'
import { BaseSyncClient } from './BaseSyncClient.js'
import { createDuckDBAdapter } from './adapters/duckdb.js'
import { createSQLiteAdapter } from './adapters/sqlite.js'
import { createMySQLAdapter } from './adapters/mysql.js'
import type { DatabaseAdapter } from './adapters/types.js'

/**
 * Configuration for creating a sync client
 */
export interface SyncClientConfig {
  /** Database type */
  type: DatabaseType
  /** Connection URL or file path */
  url: string
}

/**
 * Create a database adapter based on type
 */
function createAdapter(type: DatabaseType, url: string): DatabaseAdapter {
  switch (type) {
    case 'duckdb':
      return createDuckDBAdapter(url)
    case 'sqlite':
      return createSQLiteAdapter(url)
    case 'mysql':
      return createMySQLAdapter(url)
    case 'postgres':
      throw new Error('PostgreSQL should use PostgresClient directly for full feature support')
    default:
      throw new Error(`Unsupported database type: ${type}`)
  }
}

/**
 * Create a sync client for the specified database type.
 *
 * For PostgreSQL, use PostgresClient directly for full feature support
 * (advisory locks, sync observability, managed webhooks).
 *
 * For other databases (DuckDB, SQLite, MySQL), this factory returns
 * a BaseSyncClient that supports core sync operations.
 *
 * @example
 * ```typescript
 * // DuckDB
 * const client = createSyncClient({ type: 'duckdb', url: './stripe.duckdb' })
 *
 * // SQLite
 * const client = createSyncClient({ type: 'sqlite', url: './stripe.sqlite' })
 *
 * // MySQL
 * const client = createSyncClient({ type: 'mysql', url: 'mysql://user:pass@host/db' })
 * ```
 */
export function createSyncClient(config: SyncClientConfig): SyncDatabaseClient {
  const adapter = createAdapter(config.type, config.url)
  return new BaseSyncClient(adapter)
}

/**
 * Create a sync client from just type and URL (convenience overload)
 */
export function createSyncClientFromUrl(type: DatabaseType, url: string): SyncDatabaseClient {
  return createSyncClient({ type, url })
}

// Re-export for convenience
export { BaseSyncClient }
export type { DatabaseType }
