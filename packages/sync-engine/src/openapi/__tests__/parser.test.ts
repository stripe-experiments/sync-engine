import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { StripeOpenAPIParser } from '../parser'
import type { OpenAPIParser } from '../types'
import { writeFile, unlink } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

/**
 * Unit tests for OpenAPI Parser
 *
 * Tests parsing of OpenAPI specifications with $ref resolution and schema extraction.
 */

describe('StripeOpenAPIParser', () => {
  let parser: OpenAPIParser
  let tempFiles: string[] = []

  beforeEach(() => {
    parser = new StripeOpenAPIParser()
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
    const fileName = join(tmpdir(), `test-spec-${Date.now()}-${Math.random()}.json`)
    await writeFile(fileName, JSON.stringify(spec, null, 2))
    tempFiles.push(fileName)
    return fileName
  }

  describe('loadSpec', () => {
    it('should load a valid OpenAPI spec', async () => {
      const spec = {
        openapi: '3.0.0',
        info: { title: 'Test API', version: '1.0.0' },
        components: {
          schemas: {
            customer: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                email: { type: 'string', nullable: true },
              },
            },
          },
        },
      }

      const specFile = await createTempSpec(spec)
      await parser.loadSpec(specFile)

      expect(parser.isLoaded()).toBe(true)
      expect(parser.getApiVersion()).toBe('1.0.0')
      expect(parser.listObjectTypes()).toContain('customer')
    })

    it('should handle missing file gracefully', async () => {
      await expect(parser.loadSpec('/nonexistent/file.json')).rejects.toThrow('Failed to load OpenAPI spec')
    })

    it('should validate OpenAPI format', async () => {
      const invalidSpec = {
        title: 'Not OpenAPI',
        version: '1.0.0',
      }

      const specFile = await createTempSpec(invalidSpec)
      await expect(parser.loadSpec(specFile)).rejects.toThrow("missing 'openapi' or 'swagger' field")
    })

    it('should validate components.schemas exists', async () => {
      const invalidSpec = {
        openapi: '3.0.0',
        info: { title: 'Test API', version: '1.0.0' },
      }

      const specFile = await createTempSpec(invalidSpec)
      await expect(parser.loadSpec(specFile)).rejects.toThrow("missing 'components.schemas' section")
    })

    it('should handle malformed JSON', async () => {
      const fileName = join(tmpdir(), `invalid-json-${Date.now()}.json`)
      await writeFile(fileName, '{ invalid json }')
      tempFiles.push(fileName)

      await expect(parser.loadSpec(fileName)).rejects.toThrow('Failed to load OpenAPI spec')
    })
  })

  describe('getObjectSchema', () => {
    beforeEach(async () => {
      const spec = {
        openapi: '3.0.0',
        info: { title: 'Test API', version: '2024-12-18' },
        components: {
          schemas: {
            customer: {
              type: 'object',
              description: 'A customer object',
              required: ['id'],
              properties: {
                id: { type: 'string', description: 'Unique identifier' },
                email: { type: 'string', nullable: true },
                balance: { type: 'integer', format: 'unix-time' },
                metadata: { type: 'object' },
                preferred_locales: {
                  type: 'array',
                  items: { type: 'string' },
                },
                addresses: {
                  type: 'array',
                  items: { type: 'object', properties: { line1: { type: 'string' } } },
                },
              },
            },
            charge: {
              type: 'object',
              properties: {
                customer: { $ref: '#/components/schemas/customer' },
              },
            },
          },
        },
      }

      const specFile = await createTempSpec(spec)
      await parser.loadSpec(specFile)
    })

    it('should throw if no spec loaded', () => {
      const emptyParser = new StripeOpenAPIParser()
      expect(() => emptyParser.getObjectSchema('customer')).toThrow('No OpenAPI spec loaded')
    })

    it('should return null for nonexistent schema', () => {
      const result = parser.getObjectSchema('nonexistent')
      expect(result).toBeNull()
    })

    it('should parse basic object schema', () => {
      const result = parser.getObjectSchema('customer')

      expect(result).toBeDefined()
      expect(result!.name).toBe('customer')
      expect(result!.description).toBe('A customer object')
      expect(result!.required).toEqual(['id'])
      expect(result!.properties).toHaveLength(6)

      // Check specific properties
      const idProp = result!.properties.find(p => p.name === 'id')
      expect(idProp).toBeDefined()
      expect(idProp!.type).toBe('string')
      expect(idProp!.nullable).toBe(false)
      expect(idProp!.description).toBe('Unique identifier')
    })

    it('should handle nullable properties', () => {
      const result = parser.getObjectSchema('customer')
      const emailProp = result!.properties.find(p => p.name === 'email')

      expect(emailProp!.nullable).toBe(true)
    })

    it('should handle properties with formats', () => {
      const result = parser.getObjectSchema('customer')
      const balanceProp = result!.properties.find(p => p.name === 'balance')

      expect(balanceProp!.type).toBe('integer')
      expect(balanceProp!.format).toBe('unix-time')
    })

    it('should handle array properties', () => {
      const result = parser.getObjectSchema('customer')

      const localesProp = result!.properties.find(p => p.name === 'preferred_locales')
      expect(localesProp!.type).toBe('array')
      expect(localesProp!.itemType).toBe('string')

      const addressesProp = result!.properties.find(p => p.name === 'addresses')
      expect(addressesProp!.type).toBe('array')
      expect(addressesProp!.itemType).toBe('object')
    })

    it('should resolve $ref references', () => {
      const result = parser.getObjectSchema('charge')

      expect(result!.properties).toHaveLength(1)
      const customerProp = result!.properties.find(p => p.name === 'customer')
      expect(customerProp).toBeDefined()
      expect(customerProp!.type).toBe('object')
    })
  })

  describe('listObjectTypes', () => {
    it('should throw if no spec loaded', () => {
      expect(() => parser.listObjectTypes()).toThrow('No OpenAPI spec loaded')
    })

    it('should return sorted list of schema names', async () => {
      const spec = {
        openapi: '3.0.0',
        info: { title: 'Test API', version: '1.0.0' },
        components: {
          schemas: {
            zebra: { type: 'object', properties: {} },
            apple: { type: 'object', properties: {} },
            banana: { type: 'object', properties: {} },
          },
        },
      }

      const specFile = await createTempSpec(spec)
      await parser.loadSpec(specFile)

      const result = parser.listObjectTypes()
      expect(result).toEqual(['apple', 'banana', 'zebra'])
    })
  })

  describe('getApiVersion', () => {
    it('should throw if no spec loaded', () => {
      expect(() => parser.getApiVersion()).toThrow('No OpenAPI spec loaded')
    })

    it('should return version from spec info', async () => {
      const spec = {
        openapi: '3.0.0',
        info: { title: 'Test API', version: '2024-12-18.special' },
        components: { schemas: {} },
      }

      const specFile = await createTempSpec(spec)
      await parser.loadSpec(specFile)

      expect(parser.getApiVersion()).toBe('2024-12-18.special')
    })

    it('should handle missing version', async () => {
      const spec = {
        openapi: '3.0.0',
        info: { title: 'Test API' },
        components: { schemas: {} },
      }

      const specFile = await createTempSpec(spec)
      await parser.loadSpec(specFile)

      expect(parser.getApiVersion()).toBe('unknown')
    })
  })

  describe('isLoaded', () => {
    it('should return false initially', () => {
      expect(parser.isLoaded()).toBe(false)
    })

    it('should return true after loading spec', async () => {
      const spec = {
        openapi: '3.0.0',
        info: { title: 'Test API', version: '1.0.0' },
        components: { schemas: {} },
      }

      const specFile = await createTempSpec(spec)
      await parser.loadSpec(specFile)

      expect(parser.isLoaded()).toBe(true)
    })
  })

  describe('type mapping', () => {
    beforeEach(async () => {
      const spec = {
        openapi: '3.0.0',
        info: { title: 'Test API', version: '1.0.0' },
        components: {
          schemas: {
            typeTest: {
              type: 'object',
              properties: {
                stringProp: { type: 'string' },
                integerProp: { type: 'integer' },
                numberProp: { type: 'number' },
                booleanProp: { type: 'boolean' },
                objectProp: { type: 'object' },
                arrayProp: { type: 'array', items: { type: 'string' } },
                nullProp: { type: 'null' },
                enumProp: { enum: ['a', 'b', 'c'] },
                anyOfProp: { anyOf: [{ type: 'string' }, { type: 'number' }] },
                oneOfProp: { oneOf: [{ type: 'string' }, { type: 'integer' }] },
                noTypeProp: { properties: { nested: { type: 'string' } } },
                unknownTypeProp: { type: 'custom-unknown' },
              },
            },
          },
        },
      }

      const specFile = await createTempSpec(spec)
      await parser.loadSpec(specFile)
    })

    it('should map all OpenAPI types correctly', () => {
      const result = parser.getObjectSchema('typeTest')
      const propByName = (name: string) => result!.properties.find(p => p.name === name)!

      expect(propByName('stringProp').type).toBe('string')
      expect(propByName('integerProp').type).toBe('integer')
      expect(propByName('numberProp').type).toBe('number')
      expect(propByName('booleanProp').type).toBe('boolean')
      expect(propByName('objectProp').type).toBe('object')
      expect(propByName('arrayProp').type).toBe('array')
      expect(propByName('nullProp').type).toBe('null')
      expect(propByName('enumProp').type).toBe('string')
      expect(propByName('anyOfProp').type).toBe('object')
      expect(propByName('oneOfProp').type).toBe('object')
      expect(propByName('noTypeProp').type).toBe('object')
      expect(propByName('unknownTypeProp').type).toBe('object')
    })
  })
})