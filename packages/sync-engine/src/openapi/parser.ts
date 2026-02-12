/**
 * OpenAPI Parser Implementation
 *
 * Parses Stripe OpenAPI specifications with version awareness for dynamic schema generation.
 * Handles $ref resolution and extracts object definitions from components.schemas.
 */

import type {
  OpenAPIParser,
  ObjectSchema,
  PropertyDefinition,
  LoadedSpec,
  OpenAPIType,
  ResolverOptions,
} from './types'

export class StripeOpenAPIParser implements OpenAPIParser {
  private loadedSpec: LoadedSpec | null = null

  /**
   * Load an OpenAPI spec from a file path
   */
  async loadSpec(specPath: string): Promise<void> {
    try {
      const dynamicImport = new Function(
        'specifier',
        'return import(specifier)'
      ) as (specifier: string) => Promise<{ readFile: (path: string, encoding: string) => Promise<string> }>
      const { readFile } = await dynamicImport('node:fs/promises')
      const fileContent = await readFile(specPath, 'utf8')
      const spec = JSON.parse(fileContent)
      this.setLoadedSpec(spec)
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to load OpenAPI spec from ${specPath}: ${error.message}`)
      }
      throw error
    }
  }

  /**
   * Load an OpenAPI spec from an object.
   * Useful for browser/runtime fetch flows that already parsed JSON.
   */
  loadSpecObject(spec: unknown): void {
    this.setLoadedSpec(spec)
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
      return this.parseObjectSchema(objectName, schema)
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
   * Validate and store an OpenAPI specification.
   */
  private setLoadedSpec(spec: unknown): void {
    const specObject = this.asObject(spec)
    if (!specObject) {
      throw new Error('Invalid OpenAPI specification: expected JSON object')
    }

    // Validate that this is an OpenAPI spec
    if (!specObject.openapi && !specObject.swagger) {
      throw new Error(`Invalid OpenAPI specification: missing 'openapi' or 'swagger' field`)
    }

    const components = this.asObject(specObject.components)
    const schemas = this.asObject(components?.schemas)
    if (!schemas) {
      throw new Error(`Invalid OpenAPI specification: missing 'components.schemas' section`)
    }

    // Extract version and schema names
    const info = this.asObject(specObject.info)
    const version = typeof info?.version === 'string' ? info.version : 'unknown'
    const schemaNames = Object.keys(schemas)

    this.loadedSpec = {
      spec: specObject,
      version,
      schemaNames,
    }
  }

  /**
   * Parse a schema object into our ObjectSchema format.
   * Handles allOf/anyOf/oneOf and local $ref composition.
   */
  private parseObjectSchema(name: string, schema: any): ObjectSchema {
    const propertiesMap = new Map<string, Record<string, unknown>>()
    const required = new Set<string>()
    this.collectSchemaProperties(schema, propertiesMap, required, new Set<string>())

    if (propertiesMap.size === 0) {
      throw new Error(`Schema ${name} has no properties`)
    }

    const properties: PropertyDefinition[] = Array.from(propertiesMap.entries()).map(
      ([propName, propDef]) => this.parsePropertyDefinition(propName, propDef)
    )

    return {
      name,
      properties,
      description: typeof schema?.description === 'string' ? schema.description : undefined,
      required: Array.from(required),
    }
  }

  /**
   * Parse a property definition from the OpenAPI schema
   */
  private parsePropertyDefinition(name: string, def: Record<string, unknown>): PropertyDefinition {
    const normalizedDef = this.normalizePropertyDefinition(def)

    const property: PropertyDefinition = {
      name,
      type: this.mapOpenAPIType(normalizedDef),
      nullable: normalizedDef.nullable === true,
      description: typeof normalizedDef.description === 'string' ? normalizedDef.description : undefined,
      rawDefinition: normalizedDef,
    }

    // Handle format for specific types (e.g., unix-time)
    if (typeof normalizedDef.format === 'string') {
      property.format = normalizedDef.format
    }

    // Handle arrays
    if (normalizedDef.type === 'array' && normalizedDef.items) {
      const itemDef = this.asObject(normalizedDef.items)
      property.itemType = this.mapOpenAPIType(itemDef)
      property.itemDefinition = itemDef ?? normalizedDef.items
    }

    return property
  }

  /**
   * Map OpenAPI type to our internal type system
   */
  private mapOpenAPIType(def: Record<string, unknown> | null): OpenAPIType {
    if (!def) {
      return 'object'
    }

    // Handle explicit types
    if (typeof def.type === 'string') {
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

  private asObject(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  }

  private resolveLocalRef(refPath: string): Record<string, unknown> | null {
    if (!this.loadedSpec || !refPath.startsWith('#/')) {
      return null
    }

    const path = refPath
      .slice(2)
      .split('/')
      .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))

    let current: unknown = this.loadedSpec.spec
    for (const segment of path) {
      const obj = this.asObject(current)
      if (!obj || !(segment in obj)) {
        return null
      }
      current = obj[segment]
    }

    return this.asObject(current)
  }

  private normalizePropertyDefinition(def: Record<string, unknown>): Record<string, unknown> {
    const refValue = typeof def.$ref === 'string' ? def.$ref : null
    if (!refValue) {
      return def
    }

    const resolved = this.resolveLocalRef(refValue)
    if (!resolved) {
      return def
    }

    return {
      ...resolved,
      nullable: def.nullable ?? resolved.nullable,
      description: typeof def.description === 'string' ? def.description : resolved.description,
    }
  }

  private collectSchemaProperties(
    def: unknown,
    properties: Map<string, Record<string, unknown>>,
    required: Set<string>,
    seenRefs: Set<string>
  ): void {
    const defObj = this.asObject(def)
    if (!defObj) {
      return
    }

    const refValue = typeof defObj.$ref === 'string' ? defObj.$ref : null
    if (refValue) {
      if (seenRefs.has(refValue)) {
        return
      }
      seenRefs.add(refValue)
      const resolved = this.resolveLocalRef(refValue)
      if (resolved) {
        this.collectSchemaProperties(resolved, properties, required, seenRefs)
      }
      return
    }

    const propertiesValue = this.asObject(defObj.properties)
    if (propertiesValue) {
      for (const [propName, propDef] of Object.entries(propertiesValue)) {
        const parsedProp = this.asObject(propDef)
        if (parsedProp) {
          properties.set(propName, parsedProp)
        }
      }
    }

    if (Array.isArray(defObj.required)) {
      for (const requiredField of defObj.required) {
        if (typeof requiredField === 'string') {
          required.add(requiredField)
        }
      }
    }

    for (const composedSchema of [defObj.allOf, defObj.anyOf, defObj.oneOf]) {
      if (!Array.isArray(composedSchema)) {
        continue
      }
      for (const entry of composedSchema) {
        this.collectSchemaProperties(entry, properties, required, seenRefs)
      }
    }
  }
}

/**
 * Factory function to create a new OpenAPI parser instance
 */
export function createOpenAPIParser(_options?: ResolverOptions): OpenAPIParser {
  return new StripeOpenAPIParser()
}