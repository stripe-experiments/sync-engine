/**
 * Dynamic Table Generator
 *
 * Generates CREATE TABLE statements from OpenAPI schemas for any API version.
 * Supports schema evolution and idempotent operations.
 */

import type {
  TableDefinition,
  ColumnDefinition,
  ObjectSchema,
  TypeMapper,
  OpenAPIParser,
} from './types'

export interface TableGenerator {
  /** Generate CREATE TABLE SQL for a Stripe object */
  generateCreateTable(objectName: string, schema?: string): string

  /** Generate ALTER TABLE statements for schema evolution */
  generateSchemaEvolution(
    objectName: string,
    existingColumns: string[],
    schema?: string
  ): string[]

  /** Generate all tables for specified objects */
  generateAllTables(objectNames: string[], schema?: string): string[]

  /** Get table name for an object */
  getTableName(objectName: string): string
}

export interface SchemaEvolution {
  tableName: string
  alterStatements: string[]
  newColumns: ColumnDefinition[]
}

export class StripeTableGenerator implements TableGenerator {
  constructor(
    private parser: OpenAPIParser,
    private typeMapper: TypeMapper
  ) {}

  /**
   * Generate CREATE TABLE SQL for a Stripe object
   */
  generateCreateTable(objectName: string, schema = 'stripe'): string {
    const objectSchema = this.parser.getObjectSchema(objectName)
    if (!objectSchema) {
      throw new Error(`Object '${objectName}' not found in OpenAPI spec`)
    }

    const tableDefinition = this.typeMapper.mapObjectSchema(objectSchema)
    const tableName = this.getTableName(objectName)
    const apiVersion = this.parser.getApiVersion()

    const columnDefinitions = tableDefinition.columns
      .map(column => this.generateColumnDefinition(column))
      .join(',\n  ')

    const primaryKeyColumns = tableDefinition.columns
      .filter(col => col.primaryKey)
      .map(col => `"${col.name}"`)
      .join(', ')

    const primaryKeyClause = primaryKeyColumns.length > 0
      ? `,\n  PRIMARY KEY (${primaryKeyColumns})`
      : ''

    const sql = `-- Generated from OpenAPI spec version ${apiVersion}
-- Object: ${objectName}

CREATE TABLE IF NOT EXISTS "${schema}"."${tableName}" (
  ${columnDefinitions}${primaryKeyClause}
);`

    // Add indexing recommendations as comments
    const indexingComments = this.generateIndexingComments(tableDefinition, schema, tableName)
    if (indexingComments) {
      return `${sql}\n\n${indexingComments}`
    }

    return sql
  }

  /**
   * Generate ALTER TABLE statements for schema evolution
   */
  generateSchemaEvolution(
    objectName: string,
    existingColumns: string[],
    schema = 'stripe'
  ): string[] {
    const objectSchema = this.parser.getObjectSchema(objectName)
    if (!objectSchema) {
      throw new Error(`Object '${objectName}' not found in OpenAPI spec`)
    }

    const tableDefinition = this.typeMapper.mapObjectSchema(objectSchema)
    const tableName = this.getTableName(objectName)
    const existingColumnSet = new Set(existingColumns)

    const alterStatements: string[] = []
    const newColumns = tableDefinition.columns.filter(
      col => !existingColumnSet.has(col.name)
    )

    for (const column of newColumns) {
      // New columns are always nullable for safe addition
      const columnDef = this.generateColumnDefinition({ ...column, nullable: true })
      alterStatements.push(
        `ALTER TABLE "${schema}"."${tableName}" ADD COLUMN ${columnDef};`
      )
    }

    return alterStatements
  }

  /**
   * Generate all tables for specified objects
   */
  generateAllTables(objectNames: string[], schema = 'stripe'): string[] {
    return objectNames.map(objectName => this.generateCreateTable(objectName, schema))
  }

  /**
   * Get table name for an object (pluralize)
   */
  getTableName(objectName: string): string {
    // Handle special cases for Stripe object naming
    const specialCases: Record<string, string> = {
      'payment_intent': 'payment_intents',
      'setup_intent': 'setup_intents',
      'subscription_item': 'subscription_items',
      'subscription_schedule': 'subscription_schedules',
      'checkout_session': 'checkout_sessions',
      'invoice_item': 'invoice_items',
      'tax_rate': 'tax_rates',
      'credit_note': 'credit_notes',
      'balance_transaction': 'balance_transactions',
      'file_link': 'file_links',
      'webhook_endpoint': 'webhook_endpoints',
    }

    if (specialCases[objectName]) {
      return specialCases[objectName]
    }

    // Simple pluralization for most cases
    if (objectName.endsWith('s')) {
      return objectName
    }
    if (objectName.endsWith('y')) {
      return objectName.slice(0, -1) + 'ies'
    }
    return objectName + 's'
  }

  /**
   * Generate column definition SQL
   */
  private generateColumnDefinition(column: ColumnDefinition): string {
    const nullClause = column.nullable ? '' : ' NOT NULL'
    return `"${column.name}" ${column.type}${nullClause}`
  }

  /**
   * Generate indexing recommendations as SQL comments
   */
  private generateIndexingComments(
    tableDefinition: TableDefinition,
    schema: string,
    tableName: string
  ): string {
    const recommendations: string[] = []

    for (const column of tableDefinition.columns) {
      // Skip primary key columns (already indexed)
      if (column.primaryKey) continue

      // Add index recommendations for commonly queried columns
      const shouldRecommendIndex = this.shouldRecommendIndex(column)
      if (shouldRecommendIndex) {
        const indexName = `idx_${tableName}_${column.name}`

        if (column.type === 'jsonb') {
          recommendations.push(
            `-- CREATE INDEX ${indexName} ON ${schema}.${tableName} USING GIN ("${column.name}");`
          )
        } else if (column.type === 'text[]') {
          recommendations.push(
            `-- CREATE INDEX ${indexName} ON ${schema}.${tableName} USING GIN ("${column.name}");`
          )
        } else {
          recommendations.push(
            `-- CREATE INDEX ${indexName} ON ${schema}.${tableName}("${column.name}");`
          )
        }
      }
    }

    if (recommendations.length === 0) {
      return ''
    }

    return `-- Indexing recommendations:\n${recommendations.join('\n')}`
  }

  /**
   * Determine if a column should have an index recommendation
   */
  private shouldRecommendIndex(column: ColumnDefinition): boolean {
    // Commonly indexed Stripe fields
    const commonlyIndexedFields = [
      'email', 'customer', 'subscription', 'invoice', 'charge', 'payment_intent',
      'created', 'status', 'currency', 'livemode', 'metadata'
    ]

    // Recommend indexes for commonly queried fields
    if (commonlyIndexedFields.includes(column.name)) {
      return true
    }

    // Recommend GIN indexes for all jsonb and text[] columns
    if (column.type === 'jsonb' || column.type === 'text[]') {
      return true
    }

    return false
  }
}

/**
 * Factory function to create a table generator
 */
export function createTableGenerator(
  parser: OpenAPIParser,
  typeMapper: TypeMapper
): TableGenerator {
  return new StripeTableGenerator(parser, typeMapper)
}