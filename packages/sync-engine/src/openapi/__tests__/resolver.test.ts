import { describe, it, expect, beforeEach } from 'vitest'
import { ReferenceResolver, resolveReferences } from '../resolver'

/**
 * Unit tests for $ref resolution functionality
 */

describe('ReferenceResolver', () => {
  let spec: any

  beforeEach(() => {
    spec = {
      components: {
        schemas: {
          customer: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              email: { type: 'string' },
              address: { $ref: '#/components/schemas/address' },
            },
          },
          address: {
            type: 'object',
            properties: {
              line1: { type: 'string' },
              city: { type: 'string' },
            },
          },
          charge: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              customer: { $ref: '#/components/schemas/customer' },
              billing_details: {
                type: 'object',
                properties: {
                  address: { $ref: '#/components/schemas/address' },
                },
              },
            },
          },
          circularA: {
            type: 'object',
            properties: {
              b: { $ref: '#/components/schemas/circularB' },
            },
          },
          circularB: {
            type: 'object',
            properties: {
              a: { $ref: '#/components/schemas/circularA' },
            },
          },
        },
      },
    }
  })

  describe('basic reference resolution', () => {
    it('should resolve simple $ref', () => {
      const resolver = new ReferenceResolver(spec)
      const result = resolver.resolve('#/components/schemas/address')

      expect(result.type).toBe('object')
      expect(result.properties.line1.type).toBe('string')
      expect(result.properties.city.type).toBe('string')
    })

    it('should throw on invalid reference path', () => {
      const resolver = new ReferenceResolver(spec)
      expect(() => resolver.resolve('#/components/schemas/nonexistent')).toThrow('could not be resolved')
    })

    it('should throw on unsupported reference format', () => {
      const resolver = new ReferenceResolver(spec)
      expect(() => resolver.resolve('external.json#/schemas/address')).toThrow('Unsupported reference format')
    })

    it('should handle JSON Pointer encoding', () => {
      const specWithEncoding = {
        components: {
          schemas: {
            'name~with~tildes': { type: 'string' },
            'name/with/slashes': { type: 'string' },
          },
        },
      }

      const resolver = new ReferenceResolver(specWithEncoding)
      const result1 = resolver.resolve('#/components/schemas/name~0with~0tildes')
      const result2 = resolver.resolve('#/components/schemas/name~1with~1slashes')

      expect(result1.type).toBe('string')
      expect(result2.type).toBe('string')
    })
  })

  describe('nested reference resolution', () => {
    it('should resolve nested $refs in objects', () => {
      const resolver = new ReferenceResolver(spec)
      const obj = {
        customer: { $ref: '#/components/schemas/customer' },
        address: { $ref: '#/components/schemas/address' },
      }

      const result = resolver.resolveNestedRefs(obj)

      expect(result.customer.type).toBe('object')
      expect(result.customer.properties.id.type).toBe('string')
      expect(result.customer.properties.address.type).toBe('object')
      expect(result.customer.properties.address.properties.line1.type).toBe('string')
      expect(result.address.type).toBe('object')
    })

    it('should resolve $refs in arrays', () => {
      const resolver = new ReferenceResolver(spec)
      const arr = [
        { $ref: '#/components/schemas/customer' },
        { $ref: '#/components/schemas/address' },
      ]

      const result = resolver.resolveNestedRefs(arr)

      expect(result).toHaveLength(2)
      expect(result[0].type).toBe('object')
      expect(result[1].type).toBe('object')
    })

    it('should handle deeply nested refs', () => {
      const resolver = new ReferenceResolver(spec)
      const result = resolver.resolve('#/components/schemas/charge')

      expect(result.properties.customer.properties.address.type).toBe('object')
      expect(result.properties.billing_details.properties.address.type).toBe('object')
    })
  })

  describe('circular reference handling', () => {
    it('should handle circular references by default (no follow)', () => {
      const resolver = new ReferenceResolver(spec)
      const result = resolver.resolve('#/components/schemas/circularA')

      expect(result.type).toBe('object')
      expect(result.properties.b.type).toBe('object')
      // Should contain placeholder for circular ref
      expect(result.properties.b.properties.a.description).toContain('Circular reference')
    })

    it('should handle circular references with followCircular option', () => {
      const resolver = new ReferenceResolver(spec, { followCircular: true, maxDepth: 3 })

      // Should not throw, but should hit max depth
      expect(() => resolver.resolve('#/components/schemas/circularA')).toThrow('Maximum reference resolution depth')
    })
  })

  describe('depth limits', () => {
    it('should respect maxDepth setting', () => {
      const resolver = new ReferenceResolver(spec, { maxDepth: 1 })

      // This should fail because customer -> address is depth 2
      expect(() => resolver.resolve('#/components/schemas/charge')).toThrow('Maximum reference resolution depth')
    })

    it('should handle depth for nested resolution', () => {
      const resolver = new ReferenceResolver(spec, { maxDepth: 2 })
      const obj = {
        deeply: {
          nested: {
            ref: { $ref: '#/components/schemas/charge' },
          },
        },
      }

      // Should hit depth limit
      const result = resolver.resolveNestedRefs(obj)
      expect(result.deeply.nested.ref).toBeDefined()
    })
  })

  describe('hasReferences utility', () => {
    it('should detect $ref in object', () => {
      const obj = { $ref: '#/components/schemas/customer' }
      expect(ReferenceResolver.hasReferences(obj)).toBe(true)
    })

    it('should detect $ref in nested object', () => {
      const obj = { nested: { $ref: '#/components/schemas/customer' } }
      expect(ReferenceResolver.hasReferences(obj)).toBe(true)
    })

    it('should detect $ref in array', () => {
      const obj = [{ $ref: '#/components/schemas/customer' }]
      expect(ReferenceResolver.hasReferences(obj)).toBe(true)
    })

    it('should return false for objects without $refs', () => {
      const obj = { type: 'string', properties: { name: { type: 'string' } } }
      expect(ReferenceResolver.hasReferences(obj)).toBe(false)
    })

    it('should handle primitive values', () => {
      expect(ReferenceResolver.hasReferences('string')).toBe(false)
      expect(ReferenceResolver.hasReferences(42)).toBe(false)
      expect(ReferenceResolver.hasReferences(null)).toBe(false)
      expect(ReferenceResolver.hasReferences(undefined)).toBe(false)
    })
  })
})

describe('resolveReferences utility function', () => {
  it('should resolve references in an object', () => {
    const spec = {
      components: {
        schemas: {
          address: {
            type: 'object',
            properties: { city: { type: 'string' } },
          },
        },
      },
    }

    const obj = {
      billing: { $ref: '#/components/schemas/address' },
      shipping: { $ref: '#/components/schemas/address' },
    }

    const result = resolveReferences(spec, obj)

    expect(result.billing.type).toBe('object')
    expect(result.billing.properties.city.type).toBe('string')
    expect(result.shipping.type).toBe('object')
  })

  it('should return object unchanged if no references', () => {
    const spec = {}
    const obj = { type: 'string', format: 'email' }

    const result = resolveReferences(spec, obj)

    expect(result).toEqual(obj)
  })

  it('should pass through options to resolver', () => {
    const spec = {
      components: {
        schemas: {
          test: { $ref: '#/components/schemas/test' }, // Self reference
        },
      },
    }

    const obj = { $ref: '#/components/schemas/test' }

    expect(() => resolveReferences(spec, obj, { maxDepth: 1 })).toThrow('Maximum reference resolution depth')
  })
})