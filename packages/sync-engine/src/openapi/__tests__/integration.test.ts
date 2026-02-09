/**
 * Integration test for OpenAPI Parser + Type Mapper
 *
 * Verifies that the parser and type mapper work together correctly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFile, unlink } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

import { createOpenAPIParser, createTypeMapper } from '../index'
import type { OpenAPIParser, TypeMapper } from '../types'

describe('OpenAPI Parser + Type Mapper Integration', () => {
  let parser: OpenAPIParser
  let mapper: TypeMapper
  let tempFiles: string[] = []

  beforeEach(() => {
    parser = createOpenAPIParser()
    mapper = createTypeMapper()
    tempFiles = []
  })

  afterEach(async () => {
    // Clean up temp files
    for (const file of tempFiles) {
      try {
        await unlink(file)
      } catch {
        // Ignore errors
      }
    }
    tempFiles = []
  })

  const createTempSpec = async (spec: any): Promise<string> => {
    const fileName = join(tmpdir(), `integration-test-spec-${Date.now()}-${Math.random()}.json`)
    await writeFile(fileName, JSON.stringify(spec, null, 2))
    tempFiles.push(fileName)
    return fileName
  }

  it('should parse and map a complete Stripe-like customer object', async () => {
    const stripeCustomerLikeSpec = {
      openapi: '3.0.0',
      info: { title: 'Stripe API', version: '2024-12-18' },
      components: {
        schemas: {
          customer: {
            type: 'object',
            description: 'Represents a customer of your business',
            required: ['id', 'object'],
            properties: {
              id: { type: 'string', description: 'Unique identifier for the object' },
              object: { type: 'string', description: 'String representing the object type' },
              address: { type: 'object', nullable: true },
              balance: { type: 'integer', description: 'Current balance of the customer' },
              created: { type: 'integer', format: 'unix-time' },
              currency: { type: 'string', nullable: true },
              default_source: { type: 'string', nullable: true },
              delinquent: { type: 'boolean' },
              description: { type: 'string', nullable: true },
              discount: { type: 'object', nullable: true },
              email: { type: 'string', nullable: true },
              invoice_prefix: { type: 'string', nullable: true },
              invoice_settings: { type: 'object' },
              livemode: { type: 'boolean' },
              metadata: {
                type: 'object',
                additionalProperties: { type: 'string' }
              },
              name: { type: 'string', nullable: true },
              next_invoice_sequence: { type: 'integer' },
              phone: { type: 'string', nullable: true },
              preferred_locales: {
                type: 'array',
                items: { type: 'string' }
              },
              shipping: { type: 'object', nullable: true },
              tax_exempt: { type: 'string', nullable: true },
            },
          },
        },
      },
    }

    const specFile = await createTempSpec(stripeCustomerLikeSpec)
    await parser.loadSpec(specFile)

    // Parse the schema
    const customerSchema = parser.getObjectSchema('customer')
    expect(customerSchema).toBeDefined()
    expect(customerSchema!.name).toBe('customer')
    expect(customerSchema!.properties).toHaveLength(21)

    // Map to table definition
    const tableDefinition = mapper.mapObjectSchema(customerSchema!)

    expect(tableDefinition.name).toBe('customers')
    expect(tableDefinition.description).toBe('Represents a customer of your business')
    expect(tableDefinition.columns).toHaveLength(21)

    // Verify key column mappings
    const columnByName = (name: string) => tableDefinition.columns.find(col => col.name === name)!

    // Primary key
    const idColumn = columnByName('id')
    expect(idColumn.type).toBe('text')
    expect(idColumn.primaryKey).toBe(true)
    expect(idColumn.nullable).toBe(false)

    // Object type
    const objectColumn = columnByName('object')
    expect(objectColumn.type).toBe('text')
    expect(objectColumn.primaryKey).toBe(false)

    // Metadata (special Stripe field)
    const metadataColumn = columnByName('metadata')
    expect(metadataColumn.type).toBe('jsonb')
    expect(metadataColumn.nullable).toBe(false)

    // Unix timestamp (special format)
    const createdColumn = columnByName('created')
    expect(createdColumn.type).toBe('bigint')

    // Integer amounts
    const balanceColumn = columnByName('balance')
    expect(balanceColumn.type).toBe('bigint')

    // Simple array
    const localesColumn = columnByName('preferred_locales')
    expect(localesColumn.type).toBe('text[]')

    // Objects
    const addressColumn = columnByName('address')
    expect(addressColumn.type).toBe('jsonb')
    expect(addressColumn.nullable).toBe(true)

    // Boolean
    const deliquentColumn = columnByName('delinquent')
    expect(deliquentColumn.type).toBe('boolean')

    // Nullable text
    const emailColumn = columnByName('email')
    expect(emailColumn.type).toBe('text')
    expect(emailColumn.nullable).toBe(true)

    // Check that all columns have indexing options
    for (const column of tableDefinition.columns) {
      expect(column.indexingOptions).toBeDefined()
      expect(column.indexingOptions.length).toBeGreaterThan(0)

      for (const option of column.indexingOptions) {
        expect(option.type).toMatch(/^(btree|gin|gist)$/)
        expect(option.description).toBeTruthy()
        expect(option.example).toContain('CREATE INDEX')
      }
    }

    // Check column ordering (id and object should be first)
    expect(tableDefinition.columns[0].name).toBe('id')
    expect(tableDefinition.columns[1].name).toBe('object')
  })

  it('should handle array of objects correctly', async () => {
    const spec = {
      openapi: '3.0.0',
      info: { title: 'Test API', version: '1.0.0' },
      components: {
        schemas: {
          invoice: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              line_items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    amount: { type: 'integer' }
                  }
                }
              }
            }
          }
        }
      }
    }

    const specFile = await createTempSpec(spec)
    await parser.loadSpec(specFile)

    const invoiceSchema = parser.getObjectSchema('invoice')
    const tableDefinition = mapper.mapObjectSchema(invoiceSchema!)

    const lineItemsColumn = tableDefinition.columns.find(col => col.name === 'line_items')!
    expect(lineItemsColumn.type).toBe('jsonb')

    const indexingOptions = lineItemsColumn.indexingOptions
    expect(indexingOptions.some(opt => opt.type === 'gin')).toBe(true)
  })

  it('should handle complex Stripe pricing object', async () => {
    const spec = {
      openapi: '3.0.0',
      info: { title: 'Stripe API', version: '2024-12-18' },
      components: {
        schemas: {
          payment_intent: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              object: { type: 'string' },
              amount: { type: 'integer' },
              amount_capturable: { type: 'integer' },
              amount_details: { type: 'object' },
              amount_received: { type: 'integer' },
              application: { type: 'string', nullable: true },
              charges: {
                type: 'object',
                properties: {
                  object: { type: 'string' },
                  data: {
                    type: 'array',
                    items: { type: 'object' }
                  },
                  has_more: { type: 'boolean' },
                  total_count: { type: 'integer' },
                  url: { type: 'string' }
                }
              },
              client_secret: { type: 'string', nullable: true },
              confirmation_method: { type: 'string' },
              created: { type: 'integer', format: 'unix-time' },
              currency: { type: 'string' },
              customer: { type: 'string', nullable: true },
              description: { type: 'string', nullable: true },
              last_payment_error: { type: 'object', nullable: true },
              latest_charge: { type: 'string', nullable: true },
              livemode: { type: 'boolean' },
              metadata: { type: 'object' },
              next_action: { type: 'object', nullable: true },
              payment_method: { type: 'string', nullable: true },
              payment_method_options: { type: 'object' },
              payment_method_types: {
                type: 'array',
                items: { type: 'string' }
              },
              processing: { type: 'object', nullable: true },
              receipt_email: { type: 'string', nullable: true },
              setup_future_usage: { type: 'string', nullable: true },
              shipping: { type: 'object', nullable: true },
              status: { type: 'string' },
              transfer_data: { type: 'object', nullable: true },
              transfer_group: { type: 'string', nullable: true }
            }
          }
        }
      }
    }

    const specFile = await createTempSpec(spec)
    await parser.loadSpec(specFile)

    const paymentIntentSchema = parser.getObjectSchema('payment_intent')
    expect(paymentIntentSchema).toBeDefined()

    const tableDefinition = mapper.mapObjectSchema(paymentIntentSchema!)

    expect(tableDefinition.name).toBe('payment_intents')
    expect(tableDefinition.columns.length).toBeGreaterThan(20)

    // Check special naming convention
    expect(tableDefinition.name).toBe('payment_intents')

    // Verify complex nested object handling
    const chargesColumn = tableDefinition.columns.find(col => col.name === 'charges')!
    expect(chargesColumn.type).toBe('jsonb')

    // Verify array of strings handling
    const paymentMethodTypesColumn = tableDefinition.columns.find(col => col.name === 'payment_method_types')!
    expect(paymentMethodTypesColumn.type).toBe('text[]')

    // Verify all columns are properly typed and have indexing options
    for (const column of tableDefinition.columns) {
      expect(['text', 'bigint', 'numeric', 'boolean', 'jsonb', 'text[]']).toContain(column.type)
      expect(column.indexingOptions).toBeDefined()
      expect(column.indexingOptions.length).toBeGreaterThan(0)
    }
  })

  it('should get API version correctly', async () => {
    const spec = {
      openapi: '3.0.0',
      info: { title: 'Stripe API', version: '2024-12-18' },
      components: { schemas: { test: { type: 'object', properties: {} } } }
    }

    const specFile = await createTempSpec(spec)
    await parser.loadSpec(specFile)

    expect(parser.getApiVersion()).toBe('2024-12-18')
  })
})