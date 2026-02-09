/**
 * OpenAPI Parser Implementation
 *
 * Parses Stripe OpenAPI specifications with version awareness for dynamic schema generation.
 * Handles $ref resolution and extracts object definitions from components.schemas.
 */

import { readFile } from 'fs/promises'
import type {
  OpenAPIParser,
  ObjectSchema,
  PropertyDefinition,
  LoadedSpec,
  OpenAPIType,
  ResolverOptions,
} from './types'
import { resolveReferences } from './resolver'

export class StripeOpenAPIParser implements OpenAPIParser {
  private loadedSpec: LoadedSpec | null = null

  /**
   * Load an OpenAPI spec from a file path
   */
  async loadSpec(specPath: string): Promise<void> {
    try {
      const fileContent = await readFile(specPath, 'utf8')
      const spec = JSON.parse(fileContent)

      // Validate that this is an OpenAPI spec
      if (!spec.openapi && !spec.swagger) {
        throw new Error(`Invalid OpenAPI specification: missing 'openapi' or 'swagger' field`)
      }

      if (!spec.components?.schemas) {
        throw new Error(`Invalid OpenAPI specification: missing 'components.schemas' section`)
      }

      // Extract version and schema names
      const version = spec.info?.version || 'unknown'
      const schemaNames = Object.keys(spec.components.schemas)

      this.loadedSpec = {
        spec,
        version,
        schemaNames,
      }
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to load OpenAPI spec from ${specPath}: ${error.message}`)
      }
      throw error
    }
  }

  /**
   * Get schema for a specific Stripe object
   */
  getObjectSchema(objectName: string): ObjectSchema | null {
    if (!this.loadedSpec) {
      throw new Error('No OpenAPI spec loaded. Call loadSpec() first.')
    }

    const schema = this.loadedSpec.spec.components.schemas[objectName]
    if (!schema) {
      return null
    }

    try {
      // Resolve all $ref references in the schema
      const resolvedSchema = resolveReferences(this.loadedSpec.spec, schema)

      return this.parseObjectSchema(objectName, resolvedSchema)
    } catch (error) {
      throw new Error(`Failed to parse schema for ${objectName}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * List all available object types in the spec
   */
  listObjectTypes(): string[] {
    if (!this.loadedSpec) {
      throw new Error('No OpenAPI spec loaded. Call loadSpec() first.')
    }

    return [...this.loadedSpec.schemaNames].sort()
  }

  /**
   * Get the API version from the spec
   */
  getApiVersion(): string {
    if (!this.loadedSpec) {
      throw new Error('No OpenAPI spec loaded. Call loadSpec() first.')
    }

    return this.loadedSpec.version
  }

  /**
   * Check if a spec is currently loaded
   */
  isLoaded(): boolean {
    return this.loadedSpec !== null
  }

  /**
   * Parse a resolved schema object into our ObjectSchema format
   */
  private parseObjectSchema(name: string, schema: any): ObjectSchema {
    if (schema.type !== 'object') {
      throw new Error(`Schema ${name} is not an object type: ${schema.type}`)
    }

    if (!schema.properties) {
      throw new Error(`Schema ${name} has no properties`)
    }

    const properties: PropertyDefinition[] = []

    for (const [propName, propDef] of Object.entries(schema.properties)) {
      const property = this.parsePropertyDefinition(propName, propDef as any)
      properties.push(property)
    }

    return {
      name,
      properties,
      description: schema.description,
      required: schema.required || [],
    }
  }

  /**
   * Parse a property definition from the OpenAPI schema
   */
  private parsePropertyDefinition(name: string, def: any): PropertyDefinition {
    const property: PropertyDefinition = {
      name,
      type: this.mapOpenAPIType(def),
      nullable: def.nullable === true,
      description: def.description,
      rawDefinition: def,
    }

    // Handle format for specific types (e.g., unix-time)
    if (def.format) {
      property.format = def.format
    }

    // Handle arrays
    if (def.type === 'array' && def.items) {
      property.itemType = this.mapOpenAPIType(def.items)
      property.itemDefinition = def.items
    }

    return property
  }

  /**
   * Map OpenAPI type to our internal type system
   */
  private mapOpenAPIType(def: any): OpenAPIType {
    // Handle explicit types
    if (def.type) {
      switch (def.type) {
        case 'string':
        case 'integer':
        case 'number':
        case 'boolean':
        case 'object':
        case 'array':
        case 'null':
          return def.type as OpenAPIType
        default:
          // Unknown type, treat as object
          return 'object'
      }
    }

    // Handle anyOf/oneOf/allOf - treat as object for now
    if (def.anyOf || def.oneOf || def.allOf) {
      return 'object'
    }

    // Handle enum - treat as string
    if (def.enum) {
      return 'string'
    }

    // If no type specified but has properties, it's an object
    if (def.properties) {
      return 'object'
    }

    // Default fallback
    return 'object'
  }
}

/**
 * Factory function to create a new OpenAPI parser instance
 */
export function createOpenAPIParser(options?: ResolverOptions): OpenAPIParser {
  return new StripeOpenAPIParser()
}