/**
 * OpenAPI to Postgres Type Mapper
 *
 * Maps OpenAPI/JSON Schema types to Postgres types with indexing optimization in mind.
 * Handles special Stripe field cases and provides indexing recommendations.
 */

import type {
  TypeMapper,
  PropertyDefinition,
  ColumnDefinition,
  ObjectSchema,
  TableDefinition,
  PostgresType,
  IndexingOption,
  OpenAPIType,
} from './types'

export class StripeTypeMapper implements TypeMapper {
  /**
   * Map an OpenAPI property to Postgres column definition
   */
  mapProperty(property: PropertyDefinition): ColumnDefinition {
    const postgresType = this.mapToPostgresType(property)
    const isPrimaryKey = this.isPrimaryKeyField(property.name)
    const nullable = property.nullable && !isPrimaryKey

    return {
      name: property.name,
      type: postgresType,
      nullable,
      primaryKey: isPrimaryKey,
      description: property.description,
      indexingOptions: this.getIndexingOptions(postgresType),
    }
  }

  /**
   * Map an entire object schema to table definition
   */
  mapObjectSchema(schema: ObjectSchema): TableDefinition {
    const columns: ColumnDefinition[] = []

    for (const property of schema.properties) {
      const column = this.mapProperty(property)
      columns.push(column)
    }

    // Ensure 'id' is always first if it exists
    columns.sort((a, b) => {
      if (a.name === 'id') return -1
      if (b.name === 'id') return 1
      if (a.name === 'object') return -1
      if (b.name === 'object') return 1
      return a.name.localeCompare(b.name)
    })

    return {
      name: this.getTableName(schema.name),
      columns,
      description: schema.description,
    }
  }

  /**
   * Get indexing recommendations for a column type
   */
  getIndexingOptions(columnType: PostgresType): IndexingOption[] {
    const options: IndexingOption[] = []

    switch (columnType) {
      case 'text':
        options.push({
          type: 'btree',
          description: 'Standard B-tree index for equality and range queries',
          example: 'CREATE INDEX idx_table_column ON schema.table(column);',
        })
        break

      case 'bigint':
        options.push({
          type: 'btree',
          description: 'B-tree index for numeric comparisons and sorting',
          example: 'CREATE INDEX idx_table_amount ON schema.table(amount);',
        })
        break

      case 'numeric':
        options.push({
          type: 'btree',
          description: 'B-tree index for decimal number operations',
          example: 'CREATE INDEX idx_table_rate ON schema.table(rate);',
        })
        break

      case 'boolean':
        options.push({
          type: 'btree',
          description: 'B-tree index for boolean filtering (though often not needed)',
          example: 'CREATE INDEX idx_table_active ON schema.table(active);',
        })
        break

      case 'jsonb':
        options.push(
          {
            type: 'gin',
            description: 'GIN index for containment queries (@>, ?, ?|, ?&)',
            example: 'CREATE INDEX idx_table_metadata ON schema.table USING GIN (metadata);',
          },
          {
            type: 'btree',
            description: 'B-tree index on specific JSON paths',
            example: "CREATE INDEX idx_table_json_field ON schema.table((metadata->>'field'));",
          }
        )
        break

      case 'text[]':
        options.push({
          type: 'gin',
          description: 'GIN index for array containment and overlap operations',
          example: 'CREATE INDEX idx_table_tags ON schema.table USING GIN (tags);',
        })
        break
    }

    return options
  }

  /**
   * Map OpenAPI type to Postgres type following the defined rules
   */
  private mapToPostgresType(property: PropertyDefinition): PostgresType {
    // Handle special Stripe fields first
    const specialType = this.mapSpecialStripeField(property)
    if (specialType) {
      return specialType
    }

    // Handle by OpenAPI type
    switch (property.type) {
      case 'string':
        return 'text'

      case 'integer':
        // Use bigint for safety (Stripe amounts can be very large)
        return 'bigint'

      case 'number':
        return 'numeric'

      case 'boolean':
        return 'boolean'

      case 'object':
        return 'jsonb'

      case 'array':
        return this.mapArrayType(property)

      case 'null':
        // Null type should not appear as column type, default to text
        return 'text'

      default:
        // Fallback for unknown types
        return 'jsonb'
    }
  }

  /**
   * Handle special Stripe field mappings
   */
  private mapSpecialStripeField(property: PropertyDefinition): PostgresType | null {
    const name = property.name

    // Primary key is always text
    if (name === 'id') {
      return 'text'
    }

    // Object type identifier
    if (name === 'object') {
      return 'text'
    }

    // Metadata is always jsonb
    if (name === 'metadata') {
      return 'jsonb'
    }

    // Unix timestamps
    if (name === 'created' || name === 'updated') {
      return 'bigint'
    }

    // Handle format-specific mappings
    if (property.format === 'unix-time') {
      return 'bigint'
    }

    return null
  }

  /**
   * Map array types based on item type complexity
   */
  private mapArrayType(property: PropertyDefinition): PostgresType {
    // If we don't know the item type, use jsonb
    if (!property.itemType) {
      return 'jsonb'
    }

    // Simple string arrays use native Postgres arrays
    if (property.itemType === 'string') {
      return 'text[]'
    }

    // Complex types (objects, nested arrays) use jsonb
    if (
      property.itemType === 'object' ||
      property.itemType === 'array' ||
      (property.itemDefinition && typeof property.itemDefinition === 'object' && property.itemDefinition.properties)
    ) {
      return 'jsonb'
    }

    // Other simple types could be arrays, but jsonb is safer for mixed content
    return 'jsonb'
  }

  /**
   * Check if a field name should be treated as a primary key
   */
  private isPrimaryKeyField(name: string): boolean {
    return name === 'id'
  }

  /**
   * Generate table name from object name (pluralize)
   */
  private getTableName(objectName: string): string {
    // Handle special cases first
    const specialCases: Record<string, string> = {
      'payment_intent': 'payment_intents',
      'setup_intent': 'setup_intents',
      'person': 'persons', // Not 'people' for consistency
      'invoice_item': 'invoice_items',
      'tax_rate': 'tax_rates',
    }

    if (specialCases[objectName]) {
      return specialCases[objectName]
    }

    // Standard pluralization rules
    if (objectName.endsWith('y')) {
      return objectName.slice(0, -1) + 'ies'
    }

    if (objectName.endsWith('s') || objectName.endsWith('sh') || objectName.endsWith('ch')) {
      return objectName + 'es'
    }

    // Default: just add 's'
    return objectName + 's'
  }
}

/**
 * Factory function to create a new type mapper instance
 */
export function createTypeMapper(): TypeMapper {
  return new StripeTypeMapper()
}