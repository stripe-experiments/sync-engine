import { BaseDialect } from './base.js'

/**
 * SQLite SQL dialect implementation
 */
export class SQLiteDialect extends BaseDialect {
  readonly name = 'sqlite'
  readonly supportsSchemas = false
  readonly supportsReturning = false // SQLite 3.35+ has limited support, but we avoid it for compatibility
  readonly supportsJsonb = false
  readonly supportsArrays = false

  quoteIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`
  }

  placeholder(_index: number): string {
    return '?'
  }

  castToJson(placeholder: string): string {
    return `json(${placeholder})`
  }

  castToText(placeholder: string): string {
    return `CAST(${placeholder} AS TEXT)`
  }

  castToInteger(placeholder: string): string {
    return `CAST(${placeholder} AS INTEGER)`
  }

  castToBoolean(placeholder: string): string {
    return `CAST(${placeholder} AS INTEGER)`
  }

  qualifyTable(schema: string, table: string): string {
    // SQLite doesn't support schemas, so we prefix table names
    return this.quoteIdentifier(`${schema}_${table}`)
  }

  jsonExtractText(column: string, path: string): string {
    return `json_extract(${column}, '$.${path}')`
  }

  jsonExtractObject(column: string, path: string): string {
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
    paramOffset: number = 0
  ): string {
    // SQLite uses lowercase 'excluded' instead of PostgreSQL's 'EXCLUDED'
    return this.buildOnConflictUpsert(table, columns, conflictKeys, updateColumns, paramOffset, 'excluded')
  }

  createSchema(_schemaName: string): string | null {
    return null // SQLite doesn't support schemas
  }

  tableExists(schema: string, table: string): string {
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

export const sqliteDialect = new SQLiteDialect()
