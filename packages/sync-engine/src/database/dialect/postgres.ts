import { BaseDialect } from './base.js'

/**
 * PostgreSQL SQL dialect implementation
 */
export class PostgresDialect extends BaseDialect {
  readonly name = 'postgres'
  readonly supportsSchemas = true
  readonly supportsReturning = true
  readonly supportsJsonb = true
  readonly supportsArrays = true

  quoteIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`
  }

  placeholder(index: number): string {
    return `$${index + 1}`
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
    return `${column}->>'${path}'`
  }

  jsonExtractObject(column: string, path: string): string {
    return `${column}->'${path}'`
  }

  now(): string {
    return 'now()'
  }

  nowUtc(): string {
    return 'now()'
  }

  buildUpsert(
    table: string,
    columns: string[],
    conflictKeys: string[],
    updateColumns: string[],
    paramOffset: number = 0
  ): string {
    return this.buildOnConflictUpsert(table, columns, conflictKeys, updateColumns, paramOffset, 'EXCLUDED')
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

export const postgresDialect = new PostgresDialect()
