/**
 * Unit tests for Dynamic Table Generator
 *
 * Tests CREATE TABLE generation, schema evolution, and table naming.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createTableGenerator, type TableGenerator } from '../tableGenerator'
import type {
  OpenAPIParser,
  TypeMapper,
  ObjectSchema,
  TableDefinition,
  ColumnDefinition
} from '../types'

describe('StripeTableGenerator', () => {
  let mockParser: OpenAPIParser
  let mockTypeMapper: TypeMapper
  let generator: TableGenerator

  beforeEach(() => {
    // Mock OpenAPI Parser
    mockParser = {
      loadSpec: vi.fn(),
      getObjectSchema: vi.fn(),
      listObjectTypes: vi.fn(),
      getApiVersion: vi.fn().mockReturnValue('2024-12-18'),
      isLoaded: vi.fn().mockReturnValue(true),
    }

    // Mock Type Mapper
    mockTypeMapper = {
      mapProperty: vi.fn(),
      mapObjectSchema: vi.fn(),
      getIndexingOptions: vi.fn(),
    }

    generator = createTableGenerator(mockParser, mockTypeMapper)
  })

  describe('generateCreateTable', () => {
    it('generates basic CREATE TABLE statement', () => {
      const mockObjectSchema: ObjectSchema = {
        name: 'customer',
        properties: [
          {
            name: 'id',
            type: 'string',
            nullable: false,
            rawDefinition: { type: 'string' },
          },
          {
            name: 'email',
            type: 'string',
            nullable: true,
            rawDefinition: { type: 'string', nullable: true },
          },
        ],
      }

      const mockTableDefinition: TableDefinition = {
        name: 'customers',
        columns: [
          {
            name: 'id',
            type: 'text',
            nullable: false,
            primaryKey: true,
            indexingOptions: [],
          },
          {
            name: 'email',
            type: 'text',
            nullable: true,
            primaryKey: false,
            indexingOptions: [],
          },
        ],
      }

      mockParser.getObjectSchema = vi.fn().mockReturnValue(mockObjectSchema)
      mockTypeMapper.mapObjectSchema = vi.fn().mockReturnValue(mockTableDefinition)

      const result = generator.generateCreateTable('customer')

      expect(result).toContain('CREATE TABLE IF NOT EXISTS "stripe"."customers"')
      expect(result).toContain('"id" text NOT NULL')
      expect(result).toContain('"email" text')
      expect(result).toContain('PRIMARY KEY ("id")')
      expect(result).toContain('-- Generated from OpenAPI spec version 2024-12-18')
      expect(result).toContain('-- Object: customer')
    })

    it('generates table with custom schema name', () => {
      const mockObjectSchema: ObjectSchema = {
        name: 'charge',
        properties: [
          {
            name: 'id',
            type: 'string',
            nullable: false,
            rawDefinition: { type: 'string' },
          },
        ],
      }

      const mockTableDefinition: TableDefinition = {
        name: 'charges',
        columns: [
          {
            name: 'id',
            type: 'text',
            nullable: false,
            primaryKey: true,
            indexingOptions: [],
          },
        ],
      }

      mockParser.getObjectSchema = vi.fn().mockReturnValue(mockObjectSchema)
      mockTypeMapper.mapObjectSchema = vi.fn().mockReturnValue(mockTableDefinition)

      const result = generator.generateCreateTable('charge', 'custom_schema')

      expect(result).toContain('CREATE TABLE IF NOT EXISTS "custom_schema"."charges"')
    })

    it('generates table with complex column types', () => {
      const mockObjectSchema: ObjectSchema = {
        name: 'subscription',
        properties: [
          {
            name: 'id',
            type: 'string',
            nullable: false,
            rawDefinition: { type: 'string' },
          },
          {
            name: 'metadata',
            type: 'object',
            nullable: false,
            rawDefinition: { type: 'object' },
          },
          {
            name: 'tags',
            type: 'array',
            nullable: true,
            rawDefinition: { type: 'array' },
          },
        ],
      }

      const mockTableDefinition: TableDefinition = {
        name: 'subscriptions',
        columns: [
          {
            name: 'id',
            type: 'text',
            nullable: false,
            primaryKey: true,
            indexingOptions: [],
          },
          {
            name: 'metadata',
            type: 'jsonb',
            nullable: false,
            primaryKey: false,
            indexingOptions: [
              {
                type: 'gin',
                description: 'GIN index for containment queries',
                example: 'CREATE INDEX idx_subscriptions_metadata ON schema.subscriptions USING GIN (metadata);',
              },
            ],
          },
          {
            name: 'tags',
            type: 'text[]',
            nullable: true,
            primaryKey: false,
            indexingOptions: [],
          },
        ],
      }

      mockParser.getObjectSchema = vi.fn().mockReturnValue(mockObjectSchema)
      mockTypeMapper.mapObjectSchema = vi.fn().mockReturnValue(mockTableDefinition)

      const result = generator.generateCreateTable('subscription')

      expect(result).toContain('"metadata" jsonb NOT NULL')
      expect(result).toContain('"tags" text[]')
      expect(result).toContain('-- CREATE INDEX idx_subscriptions_metadata')
    })

    it('includes indexing recommendations', () => {
      const mockObjectSchema: ObjectSchema = {
        name: 'customer',
        properties: [
          {
            name: 'id',
            type: 'string',
            nullable: false,
            rawDefinition: { type: 'string' },
          },
          {
            name: 'email',
            type: 'string',
            nullable: true,
            rawDefinition: { type: 'string' },
          },
          {
            name: 'metadata',
            type: 'object',
            nullable: false,
            rawDefinition: { type: 'object' },
          },
        ],
      }

      const mockTableDefinition: TableDefinition = {
        name: 'customers',
        columns: [
          {
            name: 'id',
            type: 'text',
            nullable: false,
            primaryKey: true,
            indexingOptions: [],
          },
          {
            name: 'email',
            type: 'text',
            nullable: true,
            primaryKey: false,
            indexingOptions: [],
          },
          {
            name: 'metadata',
            type: 'jsonb',
            nullable: false,
            primaryKey: false,
            indexingOptions: [],
          },
        ],
      }

      mockParser.getObjectSchema = vi.fn().mockReturnValue(mockObjectSchema)
      mockTypeMapper.mapObjectSchema = vi.fn().mockReturnValue(mockTableDefinition)

      const result = generator.generateCreateTable('customer')

      expect(result).toContain('-- Indexing recommendations:')
      expect(result).toContain('-- CREATE INDEX idx_customers_email ON stripe.customers("email");')
      expect(result).toContain('-- CREATE INDEX idx_customers_metadata ON stripe.customers USING GIN ("metadata");')
    })

    it('throws error for non-existent object', () => {
      mockParser.getObjectSchema = vi.fn().mockReturnValue(null)

      expect(() => {
        generator.generateCreateTable('non_existent')
      }).toThrow("Object 'non_existent' not found in OpenAPI spec")
    })
  })

  describe('generateSchemaEvolution', () => {
    it('generates ALTER TABLE statements for new columns', () => {
      const mockObjectSchema: ObjectSchema = {
        name: 'customer',
        properties: [
          {
            name: 'id',
            type: 'string',
            nullable: false,
            rawDefinition: { type: 'string' },
          },
          {
            name: 'email',
            type: 'string',
            nullable: true,
            rawDefinition: { type: 'string' },
          },
          {
            name: 'phone',
            type: 'string',
            nullable: true,
            rawDefinition: { type: 'string' },
          },
        ],
      }

      const mockTableDefinition: TableDefinition = {
        name: 'customers',
        columns: [
          {
            name: 'id',
            type: 'text',
            nullable: false,
            primaryKey: true,
            indexingOptions: [],
          },
          {
            name: 'email',
            type: 'text',
            nullable: true,
            primaryKey: false,
            indexingOptions: [],
          },
          {
            name: 'phone',
            type: 'text',
            nullable: true,
            primaryKey: false,
            indexingOptions: [],
          },
        ],
      }

      mockParser.getObjectSchema = vi.fn().mockReturnValue(mockObjectSchema)
      mockTypeMapper.mapObjectSchema = vi.fn().mockReturnValue(mockTableDefinition)

      // Existing columns only include id and email
      const existingColumns = ['id', 'email']
      const result = generator.generateSchemaEvolution('customer', existingColumns)

      expect(result).toHaveLength(1)
      expect(result[0]).toBe('ALTER TABLE "stripe"."customers" ADD COLUMN "phone" text;')
    })

    it('generates no statements when all columns exist', () => {
      const mockObjectSchema: ObjectSchema = {
        name: 'customer',
        properties: [
          {
            name: 'id',
            type: 'string',
            nullable: false,
            rawDefinition: { type: 'string' },
          },
          {
            name: 'email',
            type: 'string',
            nullable: true,
            rawDefinition: { type: 'string' },
          },
        ],
      }

      const mockTableDefinition: TableDefinition = {
        name: 'customers',
        columns: [
          {
            name: 'id',
            type: 'text',
            nullable: false,
            primaryKey: true,
            indexingOptions: [],
          },
          {
            name: 'email',
            type: 'text',
            nullable: true,
            primaryKey: false,
            indexingOptions: [],
          },
        ],
      }

      mockParser.getObjectSchema = vi.fn().mockReturnValue(mockObjectSchema)
      mockTypeMapper.mapObjectSchema = vi.fn().mockReturnValue(mockTableDefinition)

      const existingColumns = ['id', 'email']
      const result = generator.generateSchemaEvolution('customer', existingColumns)

      expect(result).toHaveLength(0)
    })

    it('makes new columns nullable for safe addition', () => {
      const mockObjectSchema: ObjectSchema = {
        name: 'customer',
        properties: [
          {
            name: 'id',
            type: 'string',
            nullable: false,
            rawDefinition: { type: 'string' },
          },
          {
            name: 'balance',
            type: 'integer',
            nullable: false, // NOT NULL in spec
            rawDefinition: { type: 'integer' },
          },
        ],
      }

      const mockTableDefinition: TableDefinition = {
        name: 'customers',
        columns: [
          {
            name: 'id',
            type: 'text',
            nullable: false,
            primaryKey: true,
            indexingOptions: [],
          },
          {
            name: 'balance',
            type: 'bigint',
            nullable: false, // This should be made nullable in evolution
            primaryKey: false,
            indexingOptions: [],
          },
        ],
      }

      mockParser.getObjectSchema = vi.fn().mockReturnValue(mockObjectSchema)
      mockTypeMapper.mapObjectSchema = vi.fn().mockReturnValue(mockTableDefinition)

      const existingColumns = ['id']
      const result = generator.generateSchemaEvolution('customer', existingColumns)

      expect(result).toHaveLength(1)
      // Should be nullable even though original spec says NOT NULL
      expect(result[0]).toBe('ALTER TABLE "stripe"."customers" ADD COLUMN "balance" bigint;')
    })

    it('uses custom schema name in ALTER statements', () => {
      const mockObjectSchema: ObjectSchema = {
        name: 'charge',
        properties: [
          {
            name: 'id',
            type: 'string',
            nullable: false,
            rawDefinition: { type: 'string' },
          },
          {
            name: 'amount',
            type: 'integer',
            nullable: false,
            rawDefinition: { type: 'integer' },
          },
        ],
      }

      const mockTableDefinition: TableDefinition = {
        name: 'charges',
        columns: [
          {
            name: 'id',
            type: 'text',
            nullable: false,
            primaryKey: true,
            indexingOptions: [],
          },
          {
            name: 'amount',
            type: 'bigint',
            nullable: false,
            primaryKey: false,
            indexingOptions: [],
          },
        ],
      }

      mockParser.getObjectSchema = vi.fn().mockReturnValue(mockObjectSchema)
      mockTypeMapper.mapObjectSchema = vi.fn().mockReturnValue(mockTableDefinition)

      const existingColumns = ['id']
      const result = generator.generateSchemaEvolution('charge', existingColumns, 'payments')

      expect(result[0]).toBe('ALTER TABLE "payments"."charges" ADD COLUMN "amount" bigint;')
    })

    it('throws error for non-existent object in evolution', () => {
      mockParser.getObjectSchema = vi.fn().mockReturnValue(null)

      expect(() => {
        generator.generateSchemaEvolution('non_existent', [])
      }).toThrow("Object 'non_existent' not found in OpenAPI spec")
    })
  })

  describe('generateAllTables', () => {
    it('generates CREATE TABLE for multiple objects', () => {
      const customerSchema: ObjectSchema = {
        name: 'customer',
        properties: [
          { name: 'id', type: 'string', nullable: false, rawDefinition: { type: 'string' } },
        ],
      }

      const chargeSchema: ObjectSchema = {
        name: 'charge',
        properties: [
          { name: 'id', type: 'string', nullable: false, rawDefinition: { type: 'string' } },
        ],
      }

      const customerTable: TableDefinition = {
        name: 'customers',
        columns: [
          { name: 'id', type: 'text', nullable: false, primaryKey: true, indexingOptions: [] },
        ],
      }

      const chargeTable: TableDefinition = {
        name: 'charges',
        columns: [
          { name: 'id', type: 'text', nullable: false, primaryKey: true, indexingOptions: [] },
        ],
      }

      mockParser.getObjectSchema = vi.fn()
        .mockReturnValueOnce(customerSchema)
        .mockReturnValueOnce(chargeSchema)

      mockTypeMapper.mapObjectSchema = vi.fn()
        .mockReturnValueOnce(customerTable)
        .mockReturnValueOnce(chargeTable)

      const result = generator.generateAllTables(['customer', 'charge'])

      expect(result).toHaveLength(2)
      expect(result[0]).toContain('"customers"')
      expect(result[1]).toContain('"charges"')
    })
  })

  describe('getTableName', () => {
    it('pluralizes standard object names', () => {
      expect(generator.getTableName('customer')).toBe('customers')
      expect(generator.getTableName('charge')).toBe('charges')
      expect(generator.getTableName('invoice')).toBe('invoices')
      expect(generator.getTableName('product')).toBe('products')
    })

    it('handles special case pluralization', () => {
      expect(generator.getTableName('payment_intent')).toBe('payment_intents')
      expect(generator.getTableName('setup_intent')).toBe('setup_intents')
      expect(generator.getTableName('subscription_item')).toBe('subscription_items')
      expect(generator.getTableName('tax_rate')).toBe('tax_rates')
      expect(generator.getTableName('credit_note')).toBe('credit_notes')
    })

    it('handles objects ending in y', () => {
      expect(generator.getTableName('company')).toBe('companies')
    })

    it('handles objects already plural', () => {
      expect(generator.getTableName('items')).toBe('items')
    })
  })

  describe('private methods behavior (via public interface)', () => {
    it('generates correct column definitions', () => {
      const mockObjectSchema: ObjectSchema = {
        name: 'test',
        properties: [
          {
            name: 'id',
            type: 'string',
            nullable: false,
            rawDefinition: { type: 'string' },
          },
          {
            name: 'optional_field',
            type: 'string',
            nullable: true,
            rawDefinition: { type: 'string', nullable: true },
          },
        ],
      }

      const mockTableDefinition: TableDefinition = {
        name: 'tests',
        columns: [
          {
            name: 'id',
            type: 'text',
            nullable: false,
            primaryKey: true,
            indexingOptions: [],
          },
          {
            name: 'optional_field',
            type: 'text',
            nullable: true,
            primaryKey: false,
            indexingOptions: [],
          },
        ],
      }

      mockParser.getObjectSchema = vi.fn().mockReturnValue(mockObjectSchema)
      mockTypeMapper.mapObjectSchema = vi.fn().mockReturnValue(mockTableDefinition)

      const result = generator.generateCreateTable('test')

      // NOT NULL should only be on non-nullable columns
      expect(result).toContain('"id" text NOT NULL')
      expect(result).toContain('"optional_field" text')
      expect(result).not.toContain('"optional_field" text NOT NULL')
    })

    it('recommends indexes for commonly queried fields', () => {
      const mockObjectSchema: ObjectSchema = {
        name: 'customer',
        properties: [
          {
            name: 'id',
            type: 'string',
            nullable: false,
            rawDefinition: { type: 'string' },
          },
          {
            name: 'email',
            type: 'string',
            nullable: true,
            rawDefinition: { type: 'string' },
          },
          {
            name: 'created',
            type: 'integer',
            nullable: false,
            rawDefinition: { type: 'integer' },
          },
          {
            name: 'metadata',
            type: 'object',
            nullable: false,
            rawDefinition: { type: 'object' },
          },
        ],
      }

      const mockTableDefinition: TableDefinition = {
        name: 'customers',
        columns: [
          {
            name: 'id',
            type: 'text',
            nullable: false,
            primaryKey: true,
            indexingOptions: [],
          },
          {
            name: 'email',
            type: 'text',
            nullable: true,
            primaryKey: false,
            indexingOptions: [],
          },
          {
            name: 'created',
            type: 'bigint',
            nullable: false,
            primaryKey: false,
            indexingOptions: [],
          },
          {
            name: 'metadata',
            type: 'jsonb',
            nullable: false,
            primaryKey: false,
            indexingOptions: [],
          },
        ],
      }

      mockParser.getObjectSchema = vi.fn().mockReturnValue(mockObjectSchema)
      mockTypeMapper.mapObjectSchema = vi.fn().mockReturnValue(mockTableDefinition)

      const result = generator.generateCreateTable('customer')

      // Should recommend indexes for common fields
      expect(result).toContain('-- CREATE INDEX idx_customers_email ON stripe.customers("email");')
      expect(result).toContain('-- CREATE INDEX idx_customers_created ON stripe.customers("created");')
      expect(result).toContain('-- CREATE INDEX idx_customers_metadata ON stripe.customers USING GIN ("metadata");')

      // Should NOT recommend index for primary key
      expect(result).not.toContain('idx_customers_id')
    })
  })
})