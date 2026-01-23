export * from './types.js'

import type { DatabaseAdapter, DatabaseType, AnyAdapterConfig } from './types.js'

/**
 * Create a database adapter from configuration
 * Uses dynamic imports to avoid loading native modules until needed
 *
 * @param config - Adapter configuration including type and connection URL
 * @returns A database adapter instance (not connected)
 *
 * @example
 * ```typescript
 * const adapter = await createAdapter({
 *   type: 'postgres',
 *   url: 'postgres://user:pass@localhost/db'
 * })
 * await adapter.connect()
 * ```
 */
export async function createAdapter(config: AnyAdapterConfig): Promise<DatabaseAdapter> {
  switch (config.type) {
    case 'postgres': {
      const { PostgresAdapter } = await import('./postgres.js')
      return new PostgresAdapter(config)
    }
    case 'mysql': {
      const { MySQLAdapter } = await import('./mysql.js')
      return new MySQLAdapter(config)
    }
    case 'sqlite': {
      const { SQLiteAdapter } = await import('./sqlite.js')
      return new SQLiteAdapter(config)
    }
    case 'duckdb': {
      const { DuckDBAdapter } = await import('./duckdb.js')
      return new DuckDBAdapter(config)
    }
    default:
      throw new Error(`Unsupported database type: ${(config as AnyAdapterConfig).type}`)
  }
}

/**
 * Create a database adapter from type and URL (convenience function)
 * Uses dynamic imports to avoid loading native modules until needed
 *
 * @param type - Database type
 * @param url - Connection URL or file path
 * @returns A database adapter instance (not connected)
 *
 * @example
 * ```typescript
 * const adapter = await createAdapterFromUrl('postgres', 'postgres://localhost/db')
 * await adapter.connect()
 * ```
 */
export async function createAdapterFromUrl(type: DatabaseType, url: string): Promise<DatabaseAdapter> {
  return createAdapter({ type, url } as AnyAdapterConfig)
}

/**
 * Check if a database type is supported
 */
export function isSupportedDatabaseType(type: string): type is DatabaseType {
  return ['postgres', 'mysql', 'sqlite', 'duckdb'].includes(type)
}

/**
 * Get list of supported database types
 */
export function getSupportedDatabaseTypes(): DatabaseType[] {
  return ['postgres', 'mysql', 'sqlite', 'duckdb']
}

// Individual adapters can be imported directly from their modules:
// import { PostgresAdapter } from 'stripe-experiment-sync/database/adapters/postgres'
// import { MySQLAdapter } from 'stripe-experiment-sync/database/adapters/mysql'
// import { SQLiteAdapter } from 'stripe-experiment-sync/database/adapters/sqlite'
// import { DuckDBAdapter } from 'stripe-experiment-sync/database/adapters/duckdb'
