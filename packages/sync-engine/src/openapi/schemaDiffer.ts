/**
 * Schema Diffing Logic
 *
 * Compares OpenAPI-generated schemas with existing database tables
 * and reports differences for migration planning.
 */

import type {
  OpenAPIParser,
  TypeMapper,
  TableGenerator,
  ColumnDefinition,
  TableDefinition,
} from './types'
import type { DatabaseIntrospector, DatabaseTableInfo } from '../database/introspection'

export interface SchemaDiff {
  /** Name of the table being compared */
  tableName: string

  /** Overall status of the table */
  status: 'missing' | 'extra' | 'different' | 'identical'

  /** For different tables - columns to add */
  columnsToAdd: ColumnDefinition[]

  /** For different tables - columns to remove */
  columnsToRemove: ColumnDefinition[]

  /** For different tables - columns to modify */
  columnsToModify: ColumnModification[]

  /** Indexing suggestions */
  suggestedIndexes: IndexSuggestion[]

  /** Expected table definition from OpenAPI */
  expectedDefinition?: TableDefinition

  /** Current database table info */
  currentDefinition?: DatabaseTableInfo
}

export interface ColumnModification {
  /** Column name */
  name: string

  /** Current type in database */
  currentType: string

  /** Expected type from OpenAPI */
  expectedType: string

  /** Nullable status */
  nullable: {
    current: boolean
    expected: boolean
  }

  /** Whether this change is safe (non-breaking) */
  isSafe: boolean

  /** Explanation of the change */
  reason: string
}

export interface IndexSuggestion {
  /** Column name to index */
  columnName: string

  /** Type of index to create */
  indexType: string

  /** Reason for the suggestion */
  reason: string

  /** SQL statement to create the index */
  sql: string
}

export interface SchemaComparisonOptions {
  /** Database URL for connection */
  databaseUrl: string

  /** Path to OpenAPI spec file */
  openApiSpecPath: string

  /** Stripe objects to compare */
  objects: string[]

  /** Database schema name */
  schema?: string

  /** Whether to suggest indexes */
  suggestIndexes?: boolean
}

export interface SchemaComparisonResult {
  /** All table comparisons */
  diffs: SchemaDiff[]

  /** Summary statistics */
  summary: {
    totalTables: number
    identicalTables: number
    differentTables: number
    missingTables: number
    extraTables: number
  }

  /** OpenAPI spec version used */
  apiVersion: string

  /** When the comparison was run */
  timestamp: string
}

/**
 * Main schema diffing class
 */
export class SchemaDiffer {
  constructor(
    private parser: OpenAPIParser,
    private typeMapper: TypeMapper,
    private tableGenerator: TableGenerator,
    private introspector: DatabaseIntrospector
  ) {}

  /**
   * Compare database schema with OpenAPI-generated schema
   */
  async compareSchemas(options: SchemaComparisonOptions): Promise<SchemaComparisonResult> {
    const {
      openApiSpecPath,
      objects,
      schema = 'stripe',
      suggestIndexes = true,
    } = options

    // Load OpenAPI spec
    await this.parser.loadSpec(openApiSpecPath)
    const apiVersion = this.parser.getApiVersion()

    // Get database tables
    const existingTables = await this.introspector.listTables(schema)
    const existingTableSet = new Set(existingTables)

    const diffs: SchemaDiff[] = []

    // Compare each requested object
    for (const objectName of objects) {
      const tableName = this.tableGenerator.getTableName(objectName)
      const diff = await this.compareTable(objectName, tableName, schema, suggestIndexes)
      diffs.push(diff)
    }

    // Check for extra tables (tables in DB but not in requested objects)
    const requestedTableNames = new Set(
      objects.map(obj => this.tableGenerator.getTableName(obj))
    )

    for (const existingTable of existingTables) {
      if (!requestedTableNames.has(existingTable)) {
        // This is an extra table
        const tableInfo = await this.introspector.getTableInfo(existingTable, schema)
        if (tableInfo) {
          diffs.push({
            tableName: existingTable,
            status: 'extra',
            columnsToAdd: [],
            columnsToRemove: [],
            columnsToModify: [],
            suggestedIndexes: [],
            currentDefinition: tableInfo,
          })
        }
      }
    }

    // Calculate summary
    const summary = this.calculateSummary(diffs)

    return {
      diffs,
      summary,
      apiVersion,
      timestamp: new Date().toISOString(),
    }
  }

  /**
   * Compare a single table
   */
  private async compareTable(
    objectName: string,
    tableName: string,
    schema: string,
    suggestIndexes: boolean
  ): Promise<SchemaDiff> {
    // Get expected definition from OpenAPI
    const objectSchema = this.parser.getObjectSchema(objectName)
    if (!objectSchema) {
      throw new Error(`Object '${objectName}' not found in OpenAPI spec`)
    }

    const expectedDefinition = this.typeMapper.mapObjectSchema(objectSchema)

    // Get current database table info
    const currentDefinition = await this.introspector.getTableInfo(tableName, schema)

    if (!currentDefinition) {
      // Table is missing
      const suggestedIndexes = suggestIndexes
        ? this.generateIndexSuggestions(expectedDefinition, schema, tableName)
        : []

      return {
        tableName,
        status: 'missing',
        columnsToAdd: [],
        columnsToRemove: [],
        columnsToModify: [],
        suggestedIndexes,
        expectedDefinition,
      }
    }

    // Compare columns
    const columnComparison = this.compareColumns(expectedDefinition, currentDefinition)

    // Determine overall status
    let status: SchemaDiff['status'] = 'identical'
    if (
      columnComparison.columnsToAdd.length > 0 ||
      columnComparison.columnsToRemove.length > 0 ||
      columnComparison.columnsToModify.length > 0
    ) {
      status = 'different'
    }

    // Generate index suggestions
    const suggestedIndexes = suggestIndexes
      ? this.generateIndexSuggestions(expectedDefinition, schema, tableName)
      : []

    return {
      tableName,
      status,
      ...columnComparison,
      suggestedIndexes,
      expectedDefinition,
      currentDefinition,
    }
  }

  /**
   * Compare columns between expected and current definitions
   */
  private compareColumns(expected: TableDefinition, current: DatabaseTableInfo) {
    const expectedColumns = new Map(expected.columns.map(col => [col.name, col]))
    const currentColumns = new Map(
      current.columns.map(col => [col.columnName, this.introspector.convertToColumnDefinition(col)])
    )

    const columnsToAdd: ColumnDefinition[] = []
    const columnsToRemove: ColumnDefinition[] = []
    const columnsToModify: ColumnModification[] = []

    // Find columns to add (in expected but not in current)
    for (const [name, expectedCol] of expectedColumns) {
      if (!currentColumns.has(name)) {
        columnsToAdd.push(expectedCol)
      }
    }

    // Find columns to remove and modify
    for (const [name, currentCol] of currentColumns) {
      const expectedCol = expectedColumns.get(name)

      if (!expectedCol) {
        // Column exists in database but not in OpenAPI spec
        columnsToRemove.push(currentCol)
      } else {
        // Check if column needs modification
        const modification = this.compareColumn(currentCol, expectedCol)
        if (modification) {
          columnsToModify.push(modification)
        }
      }
    }

    return { columnsToAdd, columnsToRemove, columnsToModify }
  }

  /**
   * Compare two columns and return modification if needed
   */
  private compareColumn(current: ColumnDefinition, expected: ColumnDefinition): ColumnModification | null {
    const typesDiffer = current.type !== expected.type
    const nullabilityDiffers = current.nullable !== expected.nullable

    if (!typesDiffer && !nullabilityDiffers) {
      return null
    }

    // Determine if the change is safe
    const isSafe = this.isColumnChangeSafe(current, expected)

    let reason = ''
    if (typesDiffer) {
      reason += `Type change: ${current.type} → ${expected.type}`
    }
    if (nullabilityDiffers) {
      if (reason) reason += ', '
      reason += `Nullable: ${current.nullable} → ${expected.nullable}`
    }

    return {
      name: current.name,
      currentType: current.type,
      expectedType: expected.type,
      nullable: {
        current: current.nullable,
        expected: expected.nullable,
      },
      isSafe,
      reason,
    }
  }

  /**
   * Determine if a column change is safe (non-breaking)
   */
  private isColumnChangeSafe(current: ColumnDefinition, expected: ColumnDefinition): boolean {
    // Type changes are generally unsafe
    if (current.type !== expected.type) {
      // Some type changes might be safe (e.g., integer -> bigint)
      if (current.type === 'bigint' && expected.type === 'bigint') {
        return true
      }
      return false
    }

    // Making a column nullable is safe, making it non-nullable is not
    if (current.nullable !== expected.nullable) {
      return expected.nullable // Safe if making it nullable, unsafe if making it non-nullable
    }

    return true
  }

  /**
   * Generate index suggestions for a table
   */
  private generateIndexSuggestions(
    tableDefinition: TableDefinition,
    schema: string,
    tableName: string
  ): IndexSuggestion[] {
    const suggestions: IndexSuggestion[] = []

    for (const column of tableDefinition.columns) {
      // Skip primary key columns (already indexed)
      if (column.primaryKey) continue

      // Get indexing options from type mapper
      const indexingOptions = this.typeMapper.getIndexingOptions(column.type)

      for (const option of indexingOptions) {
        if (this.shouldSuggestIndex(column)) {
          const indexName = `idx_${tableName}_${column.name}`
          const sql = this.generateIndexSQL(indexName, schema, tableName, column.name, option.type)

          suggestions.push({
            columnName: column.name,
            indexType: option.type,
            reason: option.description,
            sql,
          })
        }
      }
    }

    return suggestions
  }

  /**
   * Check if we should suggest an index for this column
   */
  private shouldSuggestIndex(column: ColumnDefinition): boolean {
    // Common Stripe fields that are frequently queried
    const commonlyIndexedFields = [
      'email', 'customer', 'subscription', 'invoice', 'charge', 'payment_intent',
      'created', 'status', 'currency', 'livemode', 'metadata'
    ]

    // Suggest indexes for commonly queried fields
    if (commonlyIndexedFields.includes(column.name)) {
      return true
    }

    // Always suggest GIN indexes for jsonb and text[] columns
    if (column.type === 'jsonb' || column.type === 'text[]') {
      return true
    }

    return false
  }

  /**
   * Generate SQL for creating an index
   */
  private generateIndexSQL(
    indexName: string,
    schema: string,
    tableName: string,
    columnName: string,
    indexType: string
  ): string {
    const quotedColumn = `"${columnName}"`
    const quotedTable = `"${schema}"."${tableName}"`

    if (indexType === 'gin') {
      return `CREATE INDEX ${indexName} ON ${quotedTable} USING GIN (${quotedColumn});`
    } else {
      return `CREATE INDEX ${indexName} ON ${quotedTable} (${quotedColumn});`
    }
  }

  /**
   * Calculate summary statistics
   */
  private calculateSummary(diffs: SchemaDiff[]) {
    const summary = {
      totalTables: diffs.length,
      identicalTables: 0,
      differentTables: 0,
      missingTables: 0,
      extraTables: 0,
    }

    for (const diff of diffs) {
      switch (diff.status) {
        case 'identical':
          summary.identicalTables++
          break
        case 'different':
          summary.differentTables++
          break
        case 'missing':
          summary.missingTables++
          break
        case 'extra':
          summary.extraTables++
          break
      }
    }

    return summary
  }

  /**
   * Generate migration script to align database with OpenAPI spec
   */
  generateMigrationScript(diffs: SchemaDiff[], schema = 'stripe'): string {
    const statements: string[] = []

    // Add header comment
    statements.push('-- Migration script generated by schema differ')
    statements.push(`-- Generated at: ${new Date().toISOString()}`)
    statements.push('')

    for (const diff of diffs) {
      if (diff.status === 'missing') {
        // Generate CREATE TABLE
        statements.push(`-- Create missing table: ${diff.tableName}`)
        const createSQL = this.tableGenerator.generateCreateTable(
          // We need to reverse-lookup the object name from table name
          diff.tableName.replace(/s$/, ''), // Simple de-pluralization
          schema
        )
        statements.push(createSQL)
        statements.push('')
      } else if (diff.status === 'different') {
        // Generate ALTER TABLE statements
        statements.push(`-- Update table: ${diff.tableName}`)

        // Add new columns
        for (const column of diff.columnsToAdd) {
          const nullable = column.nullable ? '' : ' NOT NULL'
          statements.push(
            `ALTER TABLE "${schema}"."${diff.tableName}" ADD COLUMN "${column.name}" ${column.type}${nullable};`
          )
        }

        // Note: We don't automatically drop columns or modify types as these can be destructive
        if (diff.columnsToRemove.length > 0) {
          statements.push('-- WARNING: The following columns exist in the database but not in the OpenAPI spec:')
          for (const column of diff.columnsToRemove) {
            statements.push(`-- DROP COLUMN "${column.name}"; -- Uncomment if you want to remove this column`)
          }
        }

        if (diff.columnsToModify.length > 0) {
          statements.push('-- WARNING: The following columns have type mismatches:')
          for (const mod of diff.columnsToModify) {
            statements.push(`-- ${mod.name}: ${mod.reason} (${mod.isSafe ? 'SAFE' : 'UNSAFE'})`)
            if (mod.isSafe) {
              statements.push(`-- ALTER TABLE "${schema}"."${diff.tableName}" ALTER COLUMN "${mod.name}" TYPE ${mod.expectedType};`)
            }
          }
        }

        statements.push('')
      }
    }

    // Add index suggestions
    const allIndexSuggestions = diffs.flatMap(diff => diff.suggestedIndexes)
    if (allIndexSuggestions.length > 0) {
      statements.push('-- Recommended indexes:')
      for (const suggestion of allIndexSuggestions) {
        statements.push(`-- ${suggestion.reason}`)
        statements.push(`-- ${suggestion.sql}`)
      }
    }

    return statements.join('\n')
  }
}

/**
 * Factory function to create a schema differ
 */
export function createSchemaDiffer(
  parser: OpenAPIParser,
  typeMapper: TypeMapper,
  tableGenerator: TableGenerator,
  introspector: DatabaseIntrospector
): SchemaDiffer {
  return new SchemaDiffer(parser, typeMapper, tableGenerator, introspector)
}