import { BaseDialect } from './base.js'

/**
 * MySQL SQL dialect implementation
 */
export class MySQLDialect extends BaseDialect {
  readonly name = 'mysql'
  readonly supportsSchemas = true // MySQL databases act like schemas
  readonly supportsReturning = false
  readonly supportsJsonb = false
  readonly supportsArrays = false

  quoteIdentifier(name: string): string {
    return `\`${name.replace(/`/g, '``')}\``
  }

  placeholder(_index: number): string {
    return '?'
  }

  castToJson(placeholder: string): string {
    return `CAST(${placeholder} AS JSON)`
  }

  castToText(placeholder: string): string {
    return `CAST(${placeholder} AS CHAR)`
  }

  castToInteger(placeholder: string): string {
    return `CAST(${placeholder} AS SIGNED)`
  }

  castToBoolean(placeholder: string): string {
    return `CAST(${placeholder} AS UNSIGNED)`
  }

  qualifyTable(schema: string, table: string): string {
    return `${this.quoteIdentifier(schema)}.${this.quoteIdentifier(table)}`
  }

  jsonExtractText(column: string, path: string): string {
    return `JSON_UNQUOTE(JSON_EXTRACT(${column}, '$.${path}'))`
  }

  jsonExtractObject(column: string, path: string): string {
    return `JSON_EXTRACT(${column}, '$.${path}')`
  }

  now(): string {
    return 'NOW()'
  }

  nowUtc(): string {
    return 'UTC_TIMESTAMP()'
  }

  /**
   * MySQL uses ON DUPLICATE KEY UPDATE instead of ON CONFLICT
   */
  buildUpsert(
    table: string,
    columns: string[],
    _conflictKeys: string[],
    updateColumns: string[],
    _paramOffset: number = 0
  ): string {
    const quotedColumns = columns.map((c) => this.quoteIdentifier(c))
    const placeholders = this.placeholders(columns.length)
    const updateSet = updateColumns
      .map((c) => `${this.quoteIdentifier(c)} = VALUES(${this.quoteIdentifier(c)})`)
      .join(', ')

    return `
      INSERT INTO ${table} (${quotedColumns.join(', ')})
      VALUES (${placeholders.join(', ')})
      ON DUPLICATE KEY UPDATE ${updateSet}
    `.trim()
  }

  createSchema(schemaName: string): string {
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

export const mysqlDialect = new MySQLDialect()
