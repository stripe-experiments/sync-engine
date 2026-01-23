import type { SQLDialect } from './types.js'

/**
 * SQLite SQL dialect implementation
 */
export class SQLiteDialect implements SQLDialect {
  readonly name = 'sqlite'
  readonly supportsSchemas = false
  readonly supportsReturning = false // SQLite 3.35+ has limited support, but we'll avoid it for compatibility
  readonly supportsJsonb = false // Uses JSON1 extension with TEXT storage
  readonly supportsArrays = false // No native arrays, use JSON

  quoteIdentifier(name: string): string {
    // SQLite supports double quotes for identifiers
    return `"${name.replace(/"/g, '""')}"`
  }

  placeholder(index: number): string {
    // SQLite uses ? placeholders (positional)
    return '?'
  }

  placeholders(count: number): string[] {
    return Array.from({ length: count }, () => '?')
  }

  castToJson(placeholder: string): string {
    // SQLite stores JSON as TEXT, json() validates it
    return `json(${placeholder})`
  }

  castToText(placeholder: string): string {
    return `CAST(${placeholder} AS TEXT)`
  }

  castToInteger(placeholder: string): string {
    return `CAST(${placeholder} AS INTEGER)`
  }

  castToBoolean(placeholder: string): string {
    // SQLite stores booleans as 0/1 integers
    return `CAST(${placeholder} AS INTEGER)`
  }

  qualifyTable(schema: string, table: string): string {
    // SQLite doesn't support schemas, so we prefix table names instead
    // Use underscore to simulate schema: stripe_customers instead of stripe.customers
    return this.quoteIdentifier(`${schema}_${table}`)
  }

  jsonExtractText(column: string, path: string): string {
    // SQLite JSON1 extension uses json_extract with $.path notation
    return `json_extract(${column}, '$.${path}')`
  }

  jsonExtractObject(column: string, path: string): string {
    // Same as text extraction in SQLite - json_extract returns appropriate type
    return `json_extract(${column}, '$.${path}')`
  }

  now(): string {
    return "datetime('now')"
  }

  nowUtc(): string {
    return "datetime('now')"
  }

  buildUpsert(
    table: string,
    columns: string[],
    conflictKeys: string[],
    updateColumns: string[],
    _paramOffset: number = 0
  ): string {
    const quotedColumns = columns.map((c) => this.quoteIdentifier(c))
    const placeholders = this.placeholders(columns.length)
    const conflictTarget = conflictKeys.map((k) => this.quoteIdentifier(k)).join(', ')
    const updateSet = updateColumns
      .map((c) => `${this.quoteIdentifier(c)} = excluded.${this.quoteIdentifier(c)}`)
      .join(', ')

    // SQLite uses lowercase 'excluded' instead of PostgreSQL's uppercase 'EXCLUDED'
    return `
      INSERT INTO ${table} (${quotedColumns.join(', ')})
      VALUES (${placeholders.join(', ')})
      ON CONFLICT (${conflictTarget})
      DO UPDATE SET ${updateSet}
    `.trim()
  }

  buildInsert(table: string, columns: string[], _paramOffset: number = 0): string {
    const quotedColumns = columns.map((c) => this.quoteIdentifier(c))
    const placeholders = this.placeholders(columns.length)

    return `
      INSERT INTO ${table} (${quotedColumns.join(', ')})
      VALUES (${placeholders.join(', ')})
    `.trim()
  }

  buildDelete(
    table: string,
    whereColumn: string,
    _paramIndex: number = 0,
    _returningColumns?: string[]
  ): string {
    // SQLite doesn't support RETURNING in older versions
    return `
      DELETE FROM ${table}
      WHERE ${this.quoteIdentifier(whereColumn)} = ?
    `.trim()
  }

  buildSelect(table: string, columns: string[], whereClause?: string): string {
    const cols =
      columns.length === 1 && columns[0] === '*'
        ? '*'
        : columns.map((c) => this.quoteIdentifier(c)).join(', ')

    const where = whereClause ? `WHERE ${whereClause}` : ''

    return `SELECT ${cols} FROM ${table} ${where}`.trim()
  }

  createSchema(_schemaName: string): string | null {
    // SQLite doesn't support schemas
    return null
  }

  tableExists(schema: string, table: string): string {
    // In SQLite, we use the table prefix convention
    const fullTableName = `${schema}_${table}`
    return `
      SELECT EXISTS (
        SELECT 1 FROM sqlite_master
        WHERE type = 'table'
        AND name = '${fullTableName}'
      )
    `.trim()
  }
}

/**
 * Singleton instance of SQLite dialect
 */
export const sqliteDialect = new SQLiteDialect()
