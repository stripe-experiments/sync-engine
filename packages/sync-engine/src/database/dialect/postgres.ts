import type { SQLDialect } from './types.js'

/**
 * PostgreSQL SQL dialect implementation
 */
export class PostgresDialect implements SQLDialect {
  readonly name = 'postgres'
  readonly supportsSchemas = true
  readonly supportsReturning = true
  readonly supportsJsonb = true
  readonly supportsArrays = true

  quoteIdentifier(name: string): string {
    // Escape any embedded double quotes by doubling them
    return `"${name.replace(/"/g, '""')}"`
  }

  placeholder(index: number): string {
    // PostgreSQL uses 1-based $n placeholders
    return `$${index + 1}`
  }

  placeholders(count: number): string[] {
    return Array.from({ length: count }, (_, i) => this.placeholder(i))
  }

  castToJson(placeholder: string): string {
    return `${placeholder}::jsonb`
  }

  castToText(placeholder: string): string {
    return `${placeholder}::text`
  }

  castToInteger(placeholder: string): string {
    return `${placeholder}::bigint`
  }

  castToBoolean(placeholder: string): string {
    return `${placeholder}::boolean`
  }

  qualifyTable(schema: string, table: string): string {
    return `${this.quoteIdentifier(schema)}.${this.quoteIdentifier(table)}`
  }

  jsonExtractText(column: string, path: string): string {
    // PostgreSQL uses ->> for text extraction
    return `${column}->>'${path}'`
  }

  jsonExtractObject(column: string, path: string): string {
    // PostgreSQL uses -> for JSON object extraction
    return `${column}->'${path}'`
  }

  now(): string {
    return 'now()'
  }

  nowUtc(): string {
    // PostgreSQL's now() already returns timestamptz
    return 'now()'
  }

  buildUpsert(
    table: string,
    columns: string[],
    conflictKeys: string[],
    updateColumns: string[],
    paramOffset: number = 0
  ): string {
    const quotedColumns = columns.map((c) => this.quoteIdentifier(c))
    const placeholders = columns.map((_, i) => this.placeholder(paramOffset + i))
    const conflictTarget = conflictKeys.map((k) => this.quoteIdentifier(k)).join(', ')
    const updateSet = updateColumns
      .map((c) => `${this.quoteIdentifier(c)} = EXCLUDED.${this.quoteIdentifier(c)}`)
      .join(', ')

    return `
      INSERT INTO ${table} (${quotedColumns.join(', ')})
      VALUES (${placeholders.join(', ')})
      ON CONFLICT (${conflictTarget})
      DO UPDATE SET ${updateSet}
      RETURNING *
    `.trim()
  }

  buildInsert(table: string, columns: string[], paramOffset: number = 0): string {
    const quotedColumns = columns.map((c) => this.quoteIdentifier(c))
    const placeholders = columns.map((_, i) => this.placeholder(paramOffset + i))

    return `
      INSERT INTO ${table} (${quotedColumns.join(', ')})
      VALUES (${placeholders.join(', ')})
      RETURNING *
    `.trim()
  }

  buildDelete(
    table: string,
    whereColumn: string,
    paramIndex: number = 0,
    returningColumns?: string[]
  ): string {
    const returning =
      returningColumns && returningColumns.length > 0
        ? `RETURNING ${returningColumns.map((c) => this.quoteIdentifier(c)).join(', ')}`
        : 'RETURNING *'

    return `
      DELETE FROM ${table}
      WHERE ${this.quoteIdentifier(whereColumn)} = ${this.placeholder(paramIndex)}
      ${returning}
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
    return `CREATE SCHEMA IF NOT EXISTS ${this.quoteIdentifier(schemaName)}`
  }

  tableExists(schema: string, table: string): string {
    return `
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = '${schema}'
        AND table_name = '${table}'
      )
    `.trim()
  }
}

/**
 * Singleton instance of PostgreSQL dialect
 */
export const postgresDialect = new PostgresDialect()
