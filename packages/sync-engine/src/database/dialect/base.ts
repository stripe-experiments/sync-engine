import type { SQLDialect } from './types.js'

/**
 * Base dialect class with common implementations.
 * Database-specific dialects extend this and only override what differs.
 */
export abstract class BaseDialect implements SQLDialect {
  abstract readonly name: string
  abstract readonly supportsSchemas: boolean
  abstract readonly supportsReturning: boolean
  abstract readonly supportsJsonb: boolean
  abstract readonly supportsArrays: boolean

  // These MUST be implemented by each dialect (they truly differ)
  abstract quoteIdentifier(name: string): string
  abstract placeholder(index: number): string
  abstract castToJson(placeholder: string): string
  abstract castToText(placeholder: string): string
  abstract castToInteger(placeholder: string): string
  abstract castToBoolean(placeholder: string): string
  abstract qualifyTable(schema: string, table: string): string
  abstract jsonExtractText(column: string, path: string): string
  abstract jsonExtractObject(column: string, path: string): string
  abstract now(): string
  abstract nowUtc(): string
  abstract createSchema(schemaName: string): string | null
  abstract tableExists(schema: string, table: string): string

  // MySQL needs to override this for ON DUPLICATE KEY UPDATE
  abstract buildUpsert(
    table: string,
    columns: string[],
    conflictKeys: string[],
    updateColumns: string[],
    paramOffset?: number
  ): string

  /**
   * Build placeholders for multiple parameters
   * Common implementation - uses this.placeholder()
   */
  placeholders(count: number): string[] {
    return Array.from({ length: count }, (_, i) => this.placeholder(i))
  }

  /**
   * Build INSERT query - common logic, RETURNING handled by flag
   */
  buildInsert(table: string, columns: string[], paramOffset: number = 0): string {
    const quotedColumns = columns.map((c) => this.quoteIdentifier(c))
    const placeholders = columns.map((_, i) => this.placeholder(paramOffset + i))
    const returning = this.supportsReturning ? '\n      RETURNING *' : ''

    return `
      INSERT INTO ${table} (${quotedColumns.join(', ')})
      VALUES (${placeholders.join(', ')})${returning}
    `.trim()
  }

  /**
   * Build DELETE query - common logic, RETURNING handled by flag
   */
  buildDelete(
    table: string,
    whereColumn: string,
    paramIndex: number = 0,
    returningColumns?: string[]
  ): string {
    let returning = ''
    if (this.supportsReturning) {
      returning =
        returningColumns && returningColumns.length > 0
          ? `\n      RETURNING ${returningColumns.map((c) => this.quoteIdentifier(c)).join(', ')}`
          : '\n      RETURNING *'
    }

    return `
      DELETE FROM ${table}
      WHERE ${this.quoteIdentifier(whereColumn)} = ${this.placeholder(paramIndex)}${returning}
    `.trim()
  }

  /**
   * Build SELECT query - completely common across all dialects
   */
  buildSelect(table: string, columns: string[], whereClause?: string): string {
    const cols =
      columns.length === 1 && columns[0] === '*'
        ? '*'
        : columns.map((c) => this.quoteIdentifier(c)).join(', ')

    const where = whereClause ? `WHERE ${whereClause}` : ''

    return `SELECT ${cols} FROM ${table} ${where}`.trim()
  }

  /**
   * Build ON CONFLICT upsert (PostgreSQL/DuckDB/SQLite style)
   * MySQL overrides this entirely for ON DUPLICATE KEY UPDATE
   */
  protected buildOnConflictUpsert(
    table: string,
    columns: string[],
    conflictKeys: string[],
    updateColumns: string[],
    paramOffset: number = 0,
    excludedKeyword: string = 'EXCLUDED'
  ): string {
    const quotedColumns = columns.map((c) => this.quoteIdentifier(c))
    const placeholders = columns.map((_, i) => this.placeholder(paramOffset + i))
    const conflictTarget = conflictKeys.map((k) => this.quoteIdentifier(k)).join(', ')
    const updateSet = updateColumns
      .map((c) => `${this.quoteIdentifier(c)} = ${excludedKeyword}.${this.quoteIdentifier(c)}`)
      .join(', ')
    const returning = this.supportsReturning ? '\n      RETURNING *' : ''

    return `
      INSERT INTO ${table} (${quotedColumns.join(', ')})
      VALUES (${placeholders.join(', ')})
      ON CONFLICT (${conflictTarget})
      DO UPDATE SET ${updateSet}${returning}
    `.trim()
  }
}
