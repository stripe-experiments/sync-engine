/**
 * Manual verification script for TypeMapper implementation
 * This is a simple Node.js script to verify the type mapper works correctly
 */

// Import functions - these are ES modules so we need to use import syntax
import { createTypeMapper } from '../typeMapper.js'

// Create a mapper instance
const mapper = createTypeMapper()

// Test data - sample property definitions
const testProperties = [
  {
    name: 'id',
    type: 'string',
    nullable: false,
    rawDefinition: { type: 'string' }
  },
  {
    name: 'email',
    type: 'string',
    nullable: true,
    rawDefinition: { type: 'string', nullable: true }
  },
  {
    name: 'balance',
    type: 'integer',
    nullable: false,
    rawDefinition: { type: 'integer' }
  },
  {
    name: 'metadata',
    type: 'object',
    nullable: false,
    rawDefinition: { type: 'object' }
  },
  {
    name: 'created',
    type: 'integer',
    nullable: false,
    format: 'unix-time',
    rawDefinition: { type: 'integer', format: 'unix-time' }
  },
  {
    name: 'preferred_locales',
    type: 'array',
    nullable: false,
    itemType: 'string',
    rawDefinition: { type: 'array', items: { type: 'string' } }
  },
  {
    name: 'line_items',
    type: 'array',
    nullable: false,
    itemType: 'object',
    itemDefinition: { type: 'object', properties: { id: { type: 'string' } } },
    rawDefinition: { type: 'array', items: { type: 'object' } }
  }
]

console.log('=== TypeMapper Verification ===\n')

// Test mapProperty for each test case
console.log('Testing mapProperty():')
for (const property of testProperties) {
  try {
    const result = mapper.mapProperty(property)
    console.log(`✓ ${property.name}:`)
    console.log(`  OpenAPI type: ${property.type}${property.format ? ` (${property.format})` : ''}`)
    console.log(`  Postgres type: ${result.type}`)
    console.log(`  Primary key: ${result.primaryKey}`)
    console.log(`  Nullable: ${result.nullable}`)
    console.log(`  Indexing options: ${result.indexingOptions.length} available`)
    console.log()
  } catch (error) {
    console.log(`✗ ${property.name}: ${error.message}`)
  }
}

// Test mapObjectSchema
console.log('Testing mapObjectSchema():')
const testSchema = {
  name: 'customer',
  description: 'A customer object',
  properties: testProperties
}

try {
  const tableResult = mapper.mapObjectSchema(testSchema)
  console.log(`✓ Object schema mapping:`)
  console.log(`  Object name: ${testSchema.name}`)
  console.log(`  Table name: ${tableResult.name}`)
  console.log(`  Description: ${tableResult.description}`)
  console.log(`  Columns: ${tableResult.columns.length}`)
  console.log(`  Column order: ${tableResult.columns.map(c => c.name).join(', ')}`)
  console.log()
} catch (error) {
  console.log(`✗ Object schema mapping: ${error.message}`)
}

// Test getIndexingOptions
console.log('Testing getIndexingOptions():')
const postgresTypes = ['text', 'bigint', 'numeric', 'boolean', 'jsonb', 'text[]']
for (const pgType of postgresTypes) {
  try {
    const options = mapper.getIndexingOptions(pgType)
    console.log(`✓ ${pgType}: ${options.length} indexing option(s)`)
    for (const option of options) {
      console.log(`  - ${option.type}: ${option.description}`)
    }
  } catch (error) {
    console.log(`✗ ${pgType}: ${error.message}`)
  }
}

console.log('\n=== Verification Complete ===')