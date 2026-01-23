/**
 * @module schema
 *
 * Centralized schema definition for all database types.
 * Generates database-specific DDL from a single source of truth.
 *
 * This module provides:
 * - A single source of truth for all Stripe table definitions
 * - Database-specific type mappings (TEXT vs VARCHAR, JSONB vs JSON, etc.)
 * - Schema migration utilities
 *
 * @example
 * ```typescript
 * import { generateSchema, migrateSchema } from './schema'
 *
 * // Generate DDL for a specific database
 * const ddl = generateSchema('mysql')
 *
 * // Run migrations on an adapter
 * await migrateSchema(adapter)
 * ```
 */

import type { DatabaseAdapter } from './adapters/types.js'

/**
 * List of all Stripe entity tables (without prefix)
 */
export const STRIPE_TABLES = [
  'accounts',
  'customers',
  'products',
  'prices',
  'plans',
  'subscriptions',
  'subscription_items',
  'invoices',
  'charges',
  'refunds',
  'payment_intents',
  'payment_methods',
  'setup_intents',
  'disputes',
  'credit_notes',
  'checkout_sessions',
  'tax_ids',
  'reviews',
  'early_fraud_warnings',
  'features',
  'active_entitlements',
  'subscription_schedules',
] as const

export type StripeTable = (typeof STRIPE_TABLES)[number]

/**
 * Get the full table name with prefix
 */
export function getTableName(table: string): string {
  return `stripe_${table}`
}

/**
 * Column type mappings per database
 */
interface ColumnTypes {
  text: string
  json: string
  timestamp: string
  integer: string
}

function getColumnTypes(dbType: string): ColumnTypes {
  switch (dbType) {
    case 'mysql':
      return {
        text: 'VARCHAR(255)',
        json: 'JSON',
        timestamp: 'DATETIME(3)',
        integer: 'INT AUTO_INCREMENT',
      }
    case 'sqlite':
      return {
        text: 'TEXT',
        json: 'TEXT', // SQLite stores JSON as TEXT
        timestamp: 'TEXT', // SQLite stores timestamps as TEXT
        integer: 'INTEGER',
      }
    case 'duckdb':
      return {
        text: 'TEXT',
        json: 'JSON',
        timestamp: 'TIMESTAMP',
        integer: 'INTEGER',
      }
    case 'postgres':
    default:
      return {
        text: 'TEXT',
        json: 'JSONB',
        timestamp: 'TIMESTAMPTZ',
        integer: 'SERIAL',
      }
  }
}

/**
 * Generate CREATE TABLE statement for an entity table
 */
function generateEntityTable(tableName: string, types: ColumnTypes, isAccountTable: boolean): string {
  const fullName = getTableName(tableName)

  if (isAccountTable) {
    return `
CREATE TABLE IF NOT EXISTS ${fullName} (
  id ${types.text} PRIMARY KEY,
  _raw_data ${types.json} NOT NULL,
  _api_key_hash ${types.text},
  _last_synced_at ${types.timestamp}
)`
  }

  return `
CREATE TABLE IF NOT EXISTS ${fullName} (
  id ${types.text} PRIMARY KEY,
  _raw_data ${types.json} NOT NULL,
  _account_id ${types.text} NOT NULL,
  _last_synced_at ${types.timestamp}
)`
}

/**
 * Generate CREATE INDEX statements for entity tables
 */
function generateEntityIndexes(tableName: string, isAccountTable: boolean): string[] {
  const fullName = getTableName(tableName)
  const indexes: string[] = []

  if (isAccountTable) {
    // Index on api_key_hash for lookups
    indexes.push(`CREATE INDEX IF NOT EXISTS idx_${tableName}_api_key_hash ON ${fullName} (_api_key_hash)`)
  } else {
    // Index on account_id for filtering by account
    indexes.push(`CREATE INDEX IF NOT EXISTS idx_${tableName}_account_id ON ${fullName} (_account_id)`)
  }

  return indexes
}

/**
 * Generate the cursors table DDL
 */
function generateCursorsTable(types: ColumnTypes, dbType: string): string {
  const defaultTimestamp = dbType === 'mysql' ? 'DEFAULT CURRENT_TIMESTAMP(3)' :
                          dbType === 'sqlite' ? 'DEFAULT CURRENT_TIMESTAMP' :
                          'DEFAULT CURRENT_TIMESTAMP'

  return `
CREATE TABLE IF NOT EXISTS stripe__cursors (
  account_id ${types.text} NOT NULL,
  object_type ${types.text} NOT NULL,
  cursor_value TEXT,
  updated_at ${types.timestamp} ${defaultTimestamp},
  PRIMARY KEY (account_id, object_type)
)`
}

/**
 * Generate the migrations tracking table DDL
 */
function generateMigrationsTable(types: ColumnTypes, dbType: string): string {
  const defaultTimestamp = dbType === 'mysql' ? 'DEFAULT CURRENT_TIMESTAMP(3)' :
                          dbType === 'sqlite' ? 'DEFAULT CURRENT_TIMESTAMP' :
                          'DEFAULT CURRENT_TIMESTAMP'

  const idType = dbType === 'mysql' ? 'INT AUTO_INCREMENT PRIMARY KEY' :
                 dbType === 'sqlite' ? 'INTEGER PRIMARY KEY' :
                 'INTEGER PRIMARY KEY'

  return `
CREATE TABLE IF NOT EXISTS stripe__migrations (
  id ${idType},
  name ${types.text} NOT NULL,
  applied_at ${types.timestamp} ${defaultTimestamp}
)`
}

/**
 * Generate complete schema DDL for a database type
 */
export function generateSchema(dbType: string): string {
  const types = getColumnTypes(dbType)
  const statements: string[] = []

  // Generate entity tables
  for (const table of STRIPE_TABLES) {
    statements.push(generateEntityTable(table, types, table === 'accounts'))
  }

  // Generate indexes for entity tables
  for (const table of STRIPE_TABLES) {
    statements.push(...generateEntityIndexes(table, table === 'accounts'))
  }

  // Generate internal tables
  statements.push(generateCursorsTable(types, dbType))
  statements.push(generateMigrationsTable(types, dbType))

  return statements.join(';\n') + ';'
}

/**
 * Parse schema into individual statements for execution
 */
export function parseSchemaStatements(schema: string): string[] {
  return schema
    .split(';')
    .map(s => {
      // Remove leading comments and whitespace
      let trimmed = s.trim()
      while (trimmed.startsWith('--')) {
        const newlineIndex = trimmed.indexOf('\n')
        if (newlineIndex === -1) {
          trimmed = ''
          break
        }
        trimmed = trimmed.substring(newlineIndex + 1).trim()
      }
      return trimmed
    })
    .filter(s => s.length > 0)
}

/**
 * Run schema migration on a database adapter
 */
export async function migrateSchema(adapter: DatabaseAdapter): Promise<void> {
  await adapter.connect()

  const schema = generateSchema(adapter.type)
  const statements = parseSchemaStatements(schema)

  for (const stmt of statements) {
    try {
      await adapter.query(stmt)
    } catch (error) {
      const msg = (error as Error).message
      // Ignore "already exists" errors for idempotency
      if (!msg.includes('already exists') &&
          !msg.includes('Duplicate') &&
          !msg.includes('UNIQUE constraint')) {
        throw error
      }
    }
  }
}
