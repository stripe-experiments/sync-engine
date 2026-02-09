/**
 * Unit tests for Database Introspection (no database required)
 */

import { describe, it, expect } from 'vitest'
import { DatabaseIntrospector } from '../introspection'

describe('DatabaseIntrospector Unit Tests', () => {
  // Create a mock client for unit testing
  const mockClient = {
    query: vi.fn(),
    pool: { end: vi.fn() },
  } as any

  const introspector = new DatabaseIntrospector(mockClient)

  describe('normalizePostgresType', () => {
    it('should normalize text types correctly', () => {
      expect(introspector.normalizePostgresType('text')).toBe('text')
      expect(introspector.normalizePostgresType('varchar')).toBe('text')
      expect(introspector.normalizePostgresType('character varying')).toBe('text')
    })

    it('should normalize integer types to bigint', () => {
      expect(introspector.normalizePostgresType('bigint')).toBe('bigint')
      expect(introspector.normalizePostgresType('int8')).toBe('bigint')
      expect(introspector.normalizePostgresType('integer')).toBe('bigint')
      expect(introspector.normalizePostgresType('int4')).toBe('bigint')
      expect(introspector.normalizePostgresType('int')).toBe('bigint')
    })

    it('should normalize numeric types correctly', () => {
      expect(introspector.normalizePostgresType('numeric')).toBe('numeric')
      expect(introspector.normalizePostgresType('decimal')).toBe('numeric')
    })

    it('should normalize boolean types correctly', () => {
      expect(introspector.normalizePostgresType('boolean')).toBe('boolean')
      expect(introspector.normalizePostgresType('bool')).toBe('boolean')
    })

    it('should handle jsonb correctly', () => {
      expect(introspector.normalizePostgresType('jsonb')).toBe('jsonb')
    })

    it('should handle array types correctly', () => {
      expect(introspector.normalizePostgresType('text[]')).toBe('text[]')
      expect(introspector.normalizePostgresType('_text')).toBe('text[]')
    })

    it('should default unknown types to text', () => {
      expect(introspector.normalizePostgresType('unknown_type')).toBe('text')
      expect(introspector.normalizePostgresType('custom_type')).toBe('text')
    })

    it('should be case insensitive', () => {
      expect(introspector.normalizePostgresType('TEXT')).toBe('text')
      expect(introspector.normalizePostgresType('BIGINT')).toBe('bigint')
      expect(introspector.normalizePostgresType('BOOLEAN')).toBe('boolean')
    })
  })

  describe('convertToColumnDefinition', () => {
    it('should convert basic column info correctly', () => {
      const dbColumn = {
        columnName: 'test_field',
        dataType: 'text',
        isNullable: true,
        isPrimaryKey: false,
        columnDefault: null,
      }

      const result = introspector.convertToColumnDefinition(dbColumn)

      expect(result).toEqual({
        name: 'test_field',
        type: 'text',
        nullable: true,
        primaryKey: false,
        description: undefined,
        indexingOptions: [],
      })
    })

    it('should handle primary key columns', () => {
      const dbColumn = {
        columnName: 'id',
        dataType: 'text',
        isNullable: false,
        isPrimaryKey: true,
        columnDefault: null,
      }

      const result = introspector.convertToColumnDefinition(dbColumn)

      expect(result).toEqual({
        name: 'id',
        type: 'text',
        nullable: false,
        primaryKey: true,
        description: undefined,
        indexingOptions: [],
      })
    })

    it('should normalize data types during conversion', () => {
      const dbColumn = {
        columnName: 'amount',
        dataType: 'integer',
        isNullable: false,
        isPrimaryKey: false,
        columnDefault: null,
      }

      const result = introspector.convertToColumnDefinition(dbColumn)

      expect(result.type).toBe('bigint') // integer should be normalized to bigint
    })

    it('should handle nullable columns', () => {
      const dbColumn = {
        columnName: 'optional_field',
        dataType: 'text',
        isNullable: true,
        isPrimaryKey: false,
        columnDefault: 'default_value',
      }

      const result = introspector.convertToColumnDefinition(dbColumn)

      expect(result.nullable).toBe(true)
    })
  })
})

import { vi } from 'vitest'