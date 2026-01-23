import type { SQLDialect } from './types.js'

/**
 * MySQL SQL dialect implementation
 */
export class MySQLDialect implements SQLDialect {
  readonly name = 'mysql'
  readonly supportsSchemas = true // MySQL databases act like schemas
  readonly supportsReturning = false // MySQL doesn't support RETURNING
  readonly supportsJsonb = false // MySQL has JSON but not JSONB
  readonly supportsArrays = false // No native arrays, use JSON

  quoteIdentifier(name: string): string {
    // MySQL uses backticks for identifiers
    return `\`${name.replace(/`/g, '``')}\``
  }

  placeholder(_index: number): string {
    // MySQL uses ? placeholders (positional)
    return '?'
  }

  placeholders(count: number): string[] {
    return Array.from({ length: count }, () => '?')
  }

  castToJson(placeholder: string): string {
    // MySQL's CAST to JSON
    return `CAST(${placeholder} AS JSON)`
  }

  castToText(placeholder: string): string {
    return `CAST(${placeholder} AS CHAR)`
  }

  castToInteger(placeholder: string): string {
    return `CAST(${placeholder} AS SIGNED)`
  }

  castToBoolean(placeholder: string): string {
    // MySQL uses TINYINT(1) for booleans
    return `CAST(${placeholder} AS UNSIGNED)`
  }

  qualifyTable(schema: string, table: string): string {
    // In MySQL, schema = database
    return `${this.quoteIdentifier(schema)}.${this.quoteIdentifier(table)}`
  }

  jsonExtractText(column: string, path: string): string {
    // MySQL uses JSON_UNQUOTE(JSON_EXTRACT()) for text extraction
    return `JSON_UNQUOTE(JSON_EXTRACT(${column}, '$.${path}'))`
  }

  jsonExtractObject(column: string, path: string): string {
    // MySQL uses JSON_EXTRACT for object/array extraction
    return `JSON_EXTRACT(${column}, '$.${path}')`
  }

  now(): string {
    return 'NOW()'
  }

  nowUtc(): string {
    return 'UTC_TIMESTAMP()'
  }

  buildUpsert(
    table: string,
    columns: string[],
    _conflictKeys: string[],
    updateColumns: string[],
    _paramOffset: number = 0
  ): string {
    const quotedColumns = columns.map((c) => this.quoteIdentifier(c))
    const placeholders = this.placeholders(columns.length)

    // MySQL uses ON DUPLICATE KEY UPDATE instead of ON CONFLICT
    // Note: MySQL doesn't use EXCLUDED, it uses VALUES() to reference the new values
    const updateSet = updateColumns
      .map((c) => `${this.quoteIdentifier(c)} = VALUES(${this.quoteIdentifier(c)})`)
      .join(', ')

    return `
      INSERT INTO ${table} (${quotedColumns.join(', ')})
      VALUES (${placeholders.join(', ')})
      ON DUPLICATE KEY UPDATE ${updateSet}
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
    // MySQL doesn't support RETURNING
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

  createSchema(schemaName: string): string {
    // In MySQL, creating a schema = creating a database
    return `CREATE DATABASE IF NOT EXISTS ${this.quoteIdentifier(schemaName)}`
  }

  tableExists(schema: string, table: string): string {
    return `
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = '${schema}'
        AND table_name = '${table}'
      ) AS table_exists
    `.trim()
  }
}

/**
 * Singleton instance of MySQL dialect
 */
export const mysqlDialect = new MySQLDialect()
