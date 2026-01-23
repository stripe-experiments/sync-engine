/**
 * SQL dialect interface - handles database-specific SQL syntax differences
 */
export interface SQLDialect {
  /** The dialect name */
  readonly name: string

  /** Whether this dialect supports schemas (e.g., PostgreSQL schemas vs MySQL databases) */
  readonly supportsSchemas: boolean

  /** Whether this dialect supports RETURNING clause */
  readonly supportsReturning: boolean

  /** Whether this dialect supports native JSONB type */
  readonly supportsJsonb: boolean

  /** Whether this dialect supports native array types */
  readonly supportsArrays: boolean

  /**
   * Quote an identifier (table name, column name, etc.)
   * PostgreSQL/SQLite/DuckDB: "identifier"
   * MySQL: `identifier`
   */
  quoteIdentifier(name: string): string

  /**
   * Get a parameter placeholder for the given index (0-based)
   * PostgreSQL/DuckDB: $1, $2, $3...
   * MySQL/SQLite: ?
   */
  placeholder(index: number): string

  /**
   * Build placeholders for multiple parameters
   * Returns array of placeholders for the given count
   */
  placeholders(count: number): string[]

  /**
   * Cast a value to JSON type
   * PostgreSQL: $1::jsonb
   * MySQL: CAST(? AS JSON)
   * SQLite: ? (stored as TEXT)
   * DuckDB: $1::JSON
   */
  castToJson(placeholder: string): string

  /**
   * Cast a value to text type
   * PostgreSQL: $1::text
   * MySQL: CAST(? AS CHAR)
   * SQLite: CAST(? AS TEXT)
   * DuckDB: $1::VARCHAR
   */
  castToText(placeholder: string): string

  /**
   * Cast a value to integer type
   * PostgreSQL: $1::bigint
   * MySQL: CAST(? AS SIGNED)
   * SQLite: CAST(? AS INTEGER)
   * DuckDB: $1::BIGINT
   */
  castToInteger(placeholder: string): string

  /**
   * Cast a value to boolean type
   * PostgreSQL: $1::boolean
   * MySQL: (? = 1) or CAST(? AS UNSIGNED)
   * SQLite: ? (stored as 0/1)
   * DuckDB: $1::BOOLEAN
   */
  castToBoolean(placeholder: string): string

  /**
   * Fully qualify a table name with schema
   * PostgreSQL: "schema"."table"
   * MySQL: `database`.`table`
   * SQLite: "table" (no schema support, uses table prefix)
   * DuckDB: "schema"."table"
   */
  qualifyTable(schema: string, table: string): string

  /**
   * Extract text value from JSON column
   * PostgreSQL: column->>'path'
   * MySQL: JSON_UNQUOTE(JSON_EXTRACT(column, '$.path'))
   * SQLite: json_extract(column, '$.path')
   * DuckDB: column->>'$.path'
   */
  jsonExtractText(column: string, path: string): string

  /**
   * Extract JSON object/array from JSON column
   * PostgreSQL: column->'path'
   * MySQL: JSON_EXTRACT(column, '$.path')
   * SQLite: json_extract(column, '$.path')
   * DuckDB: column->'$.path'
   */
  jsonExtractObject(column: string, path: string): string

  /**
   * Get current timestamp expression
   * PostgreSQL: now()
   * MySQL: NOW()
   * SQLite: datetime('now')
   * DuckDB: now()
   */
  now(): string

  /**
   * Get current timestamp with timezone
   * PostgreSQL: now() (returns timestamptz)
   * MySQL: UTC_TIMESTAMP()
   * SQLite: datetime('now')
   * DuckDB: now()
   */
  nowUtc(): string

  /**
   * Build an upsert (INSERT ... ON CONFLICT) query
   *
   * @param table - Fully qualified table name
   * @param columns - Column names to insert
   * @param conflictKeys - Columns that form the conflict target (primary key or unique constraint)
   * @param updateColumns - Columns to update on conflict
   * @param paramOffset - Starting parameter index (0-based)
   * @returns SQL string for the upsert
   */
  buildUpsert(
    table: string,
    columns: string[],
    conflictKeys: string[],
    updateColumns: string[],
    paramOffset?: number
  ): string

  /**
   * Build a simple INSERT query
   *
   * @param table - Fully qualified table name
   * @param columns - Column names to insert
   * @param paramOffset - Starting parameter index (0-based)
   * @returns SQL string for the insert
   */
  buildInsert(table: string, columns: string[], paramOffset?: number): string

  /**
   * Build a DELETE query with RETURNING (if supported)
   *
   * @param table - Fully qualified table name
   * @param whereColumn - Column for WHERE clause
   * @param paramIndex - Parameter index (0-based)
   * @param returningColumns - Columns to return (ignored if not supported)
   * @returns SQL string for the delete
   */
  buildDelete(
    table: string,
    whereColumn: string,
    paramIndex?: number,
    returningColumns?: string[]
  ): string

  /**
   * Build a SELECT query
   *
   * @param table - Fully qualified table name
   * @param columns - Columns to select (* for all)
   * @param whereClause - Optional WHERE clause (without WHERE keyword)
   * @returns SQL string for the select
   */
  buildSelect(table: string, columns: string[], whereClause?: string): string

  /**
   * Get the SQL for creating a schema (if supported)
   * Returns null if schemas are not supported
   */
  createSchema(schemaName: string): string | null

  /**
   * Get SQL for checking if a table exists
   */
  tableExists(schema: string, table: string): string
}

/**
 * Options for building upsert queries
 */
export interface UpsertOptions {
  /** Additional condition for update (e.g., timestamp comparison) */
  updateCondition?: string
  /** Whether to include RETURNING clause */
  returning?: boolean | string[]
}
