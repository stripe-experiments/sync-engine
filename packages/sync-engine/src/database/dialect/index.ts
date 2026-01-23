export * from './types.js'
export { BaseDialect } from './base.js'
export { PostgresDialect, postgresDialect } from './postgres.js'
export { MySQLDialect, mysqlDialect } from './mysql.js'
export { SQLiteDialect, sqliteDialect } from './sqlite.js'
export { DuckDBDialect, duckdbDialect } from './duckdb.js'

import type { SQLDialect } from './types.js'
import type { DatabaseType } from '../adapters/types.js'
import { postgresDialect } from './postgres.js'
import { mysqlDialect } from './mysql.js'
import { sqliteDialect } from './sqlite.js'
import { duckdbDialect } from './duckdb.js'

/**
 * Get the SQL dialect for a given database type
 */
export function getDialect(type: DatabaseType): SQLDialect {
  switch (type) {
    case 'postgres':
      return postgresDialect
    case 'mysql':
      return mysqlDialect
    case 'sqlite':
      return sqliteDialect
    case 'duckdb':
      return duckdbDialect
    default:
      throw new Error(`Unsupported database type: ${type}`)
  }
}
