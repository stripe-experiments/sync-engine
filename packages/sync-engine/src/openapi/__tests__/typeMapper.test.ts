/**
 * Unit tests for OpenAPI to Postgres Type Mapper
 *
 * Tests all type mapping rules, special cases, and indexing options.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { createTypeMapper } from '../typeMapper'
import type { TypeMapper, PropertyDefinition, ObjectSchema } from '../types'

describe('StripeTypeMapper', () => {
  let mapper: TypeMapper

  beforeEach(() => {
    mapper = createTypeMapper()
  })

  describe('mapProperty', () => {
    it('maps basic OpenAPI types correctly', () => {
      const testCases: Array<{ property: PropertyDefinition; expectedType: string }> = [
        {
          property: {
            name: 'name',
            type: 'string',
            nullable: false,
            rawDefinition: { type: 'string' },
          },
          expectedType: 'text',
        },
        {
          property: {
            name: 'amount',
            type: 'integer',
            nullable: false,
            rawDefinition: { type: 'integer' },
          },
          expectedType: 'bigint',
        },
        {
          property: {
            name: 'rate',
            type: 'number',
            nullable: false,
            rawDefinition: { type: 'number' },
          },
          expectedType: 'numeric',
        },
        {
          property: {
            name: 'active',
            type: 'boolean',
            nullable: false,
            rawDefinition: { type: 'boolean' },
          },
          expectedType: 'boolean',
        },
        {
          property: {
            name: 'settings',
            type: 'object',
            nullable: false,
            rawDefinition: { type: 'object' },
          },
          expectedType: 'jsonb',
        },
      ]

      for (const { property, expectedType } of testCases) {
        const result = mapper.mapProperty(property)
        expect(result.type).toBe(expectedType)
        expect(result.name).toBe(property.name)
        expect(result.nullable).toBe(property.nullable)
        expect(result.primaryKey).toBe(false)
      }
    })

    it('handles special Stripe fields correctly', () => {
      const testCases: Array<{ name: string; expectedType: string; expectedPrimaryKey: boolean }> = [
        { name: 'id', expectedType: 'text', expectedPrimaryKey: true },
        { name: 'object', expectedType: 'text', expectedPrimaryKey: false },
        { name: 'metadata', expectedType: 'jsonb', expectedPrimaryKey: false },
        { name: 'created', expectedType: 'bigint', expectedPrimaryKey: false },
        { name: 'updated', expectedType: 'bigint', expectedPrimaryKey: false },
      ]

      for (const { name, expectedType, expectedPrimaryKey } of testCases) {
        const property: PropertyDefinition = {
          name,
          type: name === 'metadata' ? 'object' : name === 'created' || name === 'updated' ? 'integer' : 'string',
          nullable: false,
          rawDefinition: { type: 'string' },
        }

        const result = mapper.mapProperty(property)
        expect(result.type).toBe(expectedType)
        expect(result.primaryKey).toBe(expectedPrimaryKey)
        expect(result.nullable).toBe(expectedPrimaryKey ? false : property.nullable)
      }
    })

    it('handles array types correctly', () => {
      // Simple string array
      const stringArrayProperty: PropertyDefinition = {
        name: 'tags',
        type: 'array',
        nullable: false,
        itemType: 'string',
        rawDefinition: { type: 'array', items: { type: 'string' } },
      }

      const stringArrayResult = mapper.mapProperty(stringArrayProperty)
      expect(stringArrayResult.type).toBe('text[]')

      // Complex object array
      const objectArrayProperty: PropertyDefinition = {
        name: 'items',
        type: 'array',
        nullable: false,
        itemType: 'object',
        itemDefinition: { type: 'object', properties: { id: { type: 'string' } } },
        rawDefinition: { type: 'array', items: { type: 'object' } },
      }

      const objectArrayResult = mapper.mapProperty(objectArrayProperty)
      expect(objectArrayResult.type).toBe('jsonb')

      // Array without item type specified
      const unknownArrayProperty: PropertyDefinition = {
        name: 'unknown',
        type: 'array',
        nullable: false,
        rawDefinition: { type: 'array' },
      }

      const unknownArrayResult = mapper.mapProperty(unknownArrayProperty)
      expect(unknownArrayResult.type).toBe('jsonb')
    })

    it('handles nullable fields correctly', () => {
      const nullableProperty: PropertyDefinition = {
        name: 'description',
        type: 'string',
        nullable: true,
        rawDefinition: { type: 'string', nullable: true },
      }

      const result = mapper.mapProperty(nullableProperty)
      expect(result.nullable).toBe(true)

      // Primary key should never be nullable
      const nullableIdProperty: PropertyDefinition = {
        name: 'id',
        type: 'string',
        nullable: true,
        rawDefinition: { type: 'string', nullable: true },
      }

      const idResult = mapper.mapProperty(nullableIdProperty)
      expect(idResult.nullable).toBe(false)
      expect(idResult.primaryKey).toBe(true)
    })

    it('handles unix-time format correctly', () => {
      const timestampProperty: PropertyDefinition = {
        name: 'timestamp',
        type: 'integer',
        nullable: false,
        format: 'unix-time',
        rawDefinition: { type: 'integer', format: 'unix-time' },
      }

      const result = mapper.mapProperty(timestampProperty)
      expect(result.type).toBe('bigint')
    })

    it('includes indexing options for all types', () => {
      const property: PropertyDefinition = {
        name: 'test',
        type: 'string',
        nullable: false,
        rawDefinition: { type: 'string' },
      }

      const result = mapper.mapProperty(property)
      expect(result.indexingOptions).toBeDefined()
      expect(result.indexingOptions.length).toBeGreaterThan(0)
      expect(result.indexingOptions[0]).toHaveProperty('type')
      expect(result.indexingOptions[0]).toHaveProperty('description')
      expect(result.indexingOptions[0]).toHaveProperty('example')
    })
  })

  describe('mapObjectSchema', () => {
    it('maps complete object schema to table definition', () => {
      const schema: ObjectSchema = {
        name: 'customer',
        description: 'Customer object',
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
          {
            name: 'metadata',
            type: 'object',
            nullable: false,
            rawDefinition: { type: 'object' },
          },
          {
            name: 'balance',
            type: 'integer',
            nullable: false,
            rawDefinition: { type: 'integer' },
          },
        ],
      }

      const result = mapper.mapObjectSchema(schema)

      expect(result.name).toBe('customers')
      expect(result.description).toBe('Customer object')
      expect(result.columns).toHaveLength(4)

      // Check that id is first
      expect(result.columns[0].name).toBe('id')
      expect(result.columns[0].primaryKey).toBe(true)

      // Check specific mappings
      const emailColumn = result.columns.find(col => col.name === 'email')
      expect(emailColumn?.type).toBe('text')
      expect(emailColumn?.nullable).toBe(true)

      const metadataColumn = result.columns.find(col => col.name === 'metadata')
      expect(metadataColumn?.type).toBe('jsonb')

      const balanceColumn = result.columns.find(col => col.name === 'balance')
      expect(balanceColumn?.type).toBe('bigint')
    })

    it('handles table naming correctly', () => {
      const testCases: Array<{ objectName: string; expectedTableName: string }> = [
        { objectName: 'customer', expectedTableName: 'customers' },
        { objectName: 'charge', expectedTableName: 'charges' },
        { objectName: 'payment_intent', expectedTableName: 'payment_intents' },
        { objectName: 'setup_intent', expectedTableName: 'setup_intents' },
        { objectName: 'person', expectedTableName: 'persons' },
        { objectName: 'company', expectedTableName: 'companies' },
        { objectName: 'tax_rate', expectedTableName: 'tax_rates' },
        { objectName: 'invoice_item', expectedTableName: 'invoice_items' },
      ]

      for (const { objectName, expectedTableName } of testCases) {
        const schema: ObjectSchema = {
          name: objectName,
          properties: [
            {
              name: 'id',
              type: 'string',
              nullable: false,
              rawDefinition: { type: 'string' },
            },
          ],
        }

        const result = mapper.mapObjectSchema(schema)
        expect(result.name).toBe(expectedTableName)
      }
    })

    it('sorts columns with id and object first', () => {
      const schema: ObjectSchema = {
        name: 'test',
        properties: [
          {
            name: 'zebra',
            type: 'string',
            nullable: false,
            rawDefinition: { type: 'string' },
          },
          {
            name: 'object',
            type: 'string',
            nullable: false,
            rawDefinition: { type: 'string' },
          },
          {
            name: 'alpha',
            type: 'string',
            nullable: false,
            rawDefinition: { type: 'string' },
          },
          {
            name: 'id',
            type: 'string',
            nullable: false,
            rawDefinition: { type: 'string' },
          },
        ],
      }

      const result = mapper.mapObjectSchema(schema)
      const columnNames = result.columns.map(col => col.name)

      expect(columnNames[0]).toBe('id')
      expect(columnNames[1]).toBe('object')
      expect(columnNames[2]).toBe('alpha')
      expect(columnNames[3]).toBe('zebra')
    })
  })

  describe('getIndexingOptions', () => {
    it('provides correct indexing options for each type', () => {
      const testCases: Array<{ type: string; expectedIndexTypes: Array<'btree' | 'gin' | 'gist'> }> = [
        { type: 'text', expectedIndexTypes: ['btree'] },
        { type: 'bigint', expectedIndexTypes: ['btree'] },
        { type: 'numeric', expectedIndexTypes: ['btree'] },
        { type: 'boolean', expectedIndexTypes: ['btree'] },
        { type: 'jsonb', expectedIndexTypes: ['gin', 'btree'] },
        { type: 'text[]', expectedIndexTypes: ['gin'] },
      ]

      for (const { type, expectedIndexTypes } of testCases) {
        const options = mapper.getIndexingOptions(type as any)
        expect(options.length).toBe(expectedIndexTypes.length)

        const actualTypes = options.map(opt => opt.type)
        expect(actualTypes).toEqual(expectedIndexTypes)

        // Verify all options have required fields
        for (const option of options) {
          expect(option.description).toBeTruthy()
          expect(option.example).toBeTruthy()
          expect(option.example).toContain('CREATE INDEX')
        }
      }
    })
  })

  describe('edge cases and error handling', () => {
    it('handles unknown OpenAPI types', () => {
      const unknownProperty: PropertyDefinition = {
        name: 'unknown',
        type: 'null' as any,
        nullable: false,
        rawDefinition: { type: 'unknown' },
      }

      const result = mapper.mapProperty(unknownProperty)
      expect(result.type).toBe('text') // null type maps to text
    })

    it('handles nested array types', () => {
      const nestedArrayProperty: PropertyDefinition = {
        name: 'nested',
        type: 'array',
        nullable: false,
        itemType: 'array',
        rawDefinition: { type: 'array', items: { type: 'array' } },
      }

      const result = mapper.mapProperty(nestedArrayProperty)
      expect(result.type).toBe('jsonb')
    })

    it('preserves description from property', () => {
      const propertyWithDescription: PropertyDefinition = {
        name: 'test',
        type: 'string',
        nullable: false,
        description: 'Test description',
        rawDefinition: { type: 'string' },
      }

      const result = mapper.mapProperty(propertyWithDescription)
      expect(result.description).toBe('Test description')
    })
  })
})