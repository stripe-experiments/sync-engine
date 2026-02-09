/**
 * Database Introspection Module
 *
 * Provides utilities to read and analyze existing database schema structure
 * for comparison with OpenAPI-generated schemas.
 */

import type { PostgresType, ColumnDefinition } from '../openapi/types'
import type { PostgresClient } from './postgres'

export interface DatabaseTableInfo {
  /** Table name */
  tableName: string

  /** Schema name (e.g., 'stripe', 'public') */
  schemaName: string

  /** All columns in the table */
  columns: DatabaseColumnInfo[]

  /** Indexes on the table */
  indexes: DatabaseIndexInfo[]

  /** Primary key columns */
  primaryKeys: string[]
}

export interface DatabaseColumnInfo {
  /** Column name */
  columnName: string

  /** Postgres data type */
  dataType: string

  /** Whether column allows NULL */
  isNullable: boolean

  /** Default value if any */
  columnDefault?: string

  /** Whether this is a primary key column */
  isPrimaryKey: boolean

  /** Character maximum length for text types */
  characterMaximumLength?: number
}

export interface DatabaseIndexInfo {
  /** Index name */
  indexName: string

  /** Index definition (CREATE INDEX ...) */
  indexDefinition: string

  /** Index type (btree, gin, etc.) */
  indexType: string

  /** Columns included in the index */
  columns: string[]

  /** Whether it's a unique index */
  isUnique: boolean
}

/**
 * Database introspection utilities
 */
export class DatabaseIntrospector {
  constructor(private client: PostgresClient) {}

  /**
   * Get information about a specific table
   */
  async getTableInfo(tableName: string, schemaName = 'stripe'): Promise<DatabaseTableInfo | null> {
    const columns = await this.getTableColumns(tableName, schemaName)
    if (columns.length === 0) {
      return null
    }

    const indexes = await this.getTableIndexes(tableName, schemaName)
    const primaryKeys = columns.filter(col => col.isPrimaryKey).map(col => col.columnName)

    return {
      tableName,
      schemaName,
      columns,
      indexes,
      primaryKeys,
    }
  }

  /**
   * Get column information for a table
   */
  async getTableColumns(tableName: string, schemaName = 'stripe'): Promise<DatabaseColumnInfo[]> {
    const query = `
      SELECT
        c.column_name,
        c.data_type,
        c.is_nullable = 'YES' as is_nullable,
        c.column_default,
        c.character_maximum_length,
        CASE
          WHEN pk.column_name IS NOT NULL THEN true
          ELSE false
        END as is_primary_key
      FROM information_schema.columns c
      LEFT JOIN (
        SELECT
          kcu.column_name,
          kcu.table_name,
          kcu.table_schema
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        WHERE tc.constraint_type = 'PRIMARY KEY'
      ) pk ON c.column_name = pk.column_name
          AND c.table_name = pk.table_name
          AND c.table_schema = pk.table_schema
      WHERE c.table_schema = $1
        AND c.table_name = $2
      ORDER BY c.ordinal_position
    `

    const result = await this.client.query(query, [schemaName, tableName])

    return result.rows.map(row => ({
      columnName: row.column_name,
      dataType: row.data_type,
      isNullable: row.is_nullable,
      columnDefault: row.column_default,
      isPrimaryKey: row.is_primary_key,
      characterMaximumLength: row.character_maximum_length,
    }))
  }

  /**
   * Get index information for a table
   */
  async getTableIndexes(tableName: string, schemaName = 'stripe'): Promise<DatabaseIndexInfo[]> {
    const query = `
      SELECT
        i.indexname as index_name,
        i.indexdef as index_definition,
        am.amname as index_type,
        ix.indisunique as is_unique,
        string_agg(a.attname, ',' ORDER BY ix.indkey::int[] <@ ARRAY[a.attnum]) as columns
      FROM pg_indexes i
      JOIN pg_class t ON t.relname = i.tablename
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_index ix ON ix.indexrelid = (
        SELECT oid FROM pg_class WHERE relname = i.indexname
      )
      JOIN pg_am am ON am.oid = (
        SELECT relam FROM pg_class WHERE oid = ix.indexrelid
      )
      LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
      WHERE n.nspname = $1
        AND i.tablename = $2
        AND i.indexname NOT LIKE '%_pkey'  -- Exclude primary key indexes
      GROUP BY i.indexname, i.indexdef, am.amname, ix.indisunique
      ORDER BY i.indexname
    `

    const result = await this.client.query(query, [schemaName, tableName])

    return result.rows.map(row => ({
      indexName: row.index_name,
      indexDefinition: row.index_definition,
      indexType: row.index_type,
      isUnique: row.is_unique,
      columns: row.columns ? row.columns.split(',') : [],
    }))
  }

  /**
   * List all tables in a schema
   */
  async listTables(schemaName = 'stripe'): Promise<string[]> {
    const query = `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = $1
        AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `

    const result = await this.client.query(query, [schemaName])
    return result.rows.map(row => row.table_name)
  }

  /**
   * Check if a schema exists
   */
  async schemaExists(schemaName: string): Promise<boolean> {
    const query = `
      SELECT schema_name
      FROM information_schema.schemata
      WHERE schema_name = $1
    `

    const result = await this.client.query(query, [schemaName])
    return result.rows.length > 0
  }

  /**
   * Convert Postgres type to our standard PostgresType enum
   */
  normalizePostgresType(pgType: string): PostgresType {
    // Handle common Postgres type mappings
    switch (pgType.toLowerCase()) {
      case 'text':
      case 'varchar':
      case 'character varying':
        return 'text'
      case 'bigint':
      case 'int8':
        return 'bigint'
      case 'integer':
      case 'int4':
      case 'int':
        return 'bigint' // We normalize all integers to bigint for consistency
      case 'numeric':
      case 'decimal':
        return 'numeric'
      case 'boolean':
      case 'bool':
        return 'boolean'
      case 'jsonb':
        return 'jsonb'
      case 'text[]':
      case '_text':
        return 'text[]'
      default:
        // For unknown types, default to text
        console.warn(`Unknown Postgres type '${pgType}', treating as 'text'`)
        return 'text'
    }
  }

  /**
   * Convert database column info to our ColumnDefinition format
   */
  convertToColumnDefinition(dbColumn: DatabaseColumnInfo): ColumnDefinition {
    return {
      name: dbColumn.columnName,
      type: this.normalizePostgresType(dbColumn.dataType),
      nullable: dbColumn.isNullable,
      primaryKey: dbColumn.isPrimaryKey,
      description: undefined, // Database doesn't store OpenAPI descriptions
      indexingOptions: [], // Will be populated by type mapper if needed
    }
  }
}

/**
 * Factory function to create a database introspector
 */
export function createDatabaseIntrospector(client: PostgresClient): DatabaseIntrospector {
  return new DatabaseIntrospector(client)
}