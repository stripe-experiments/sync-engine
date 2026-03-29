import type { OpenAPIParameter, OpenAPISpec } from '../types.js'

/** Extended schema with OAS 3.1 fields needed for JSON-in-header detection. */
export interface ExtendedSchema {
  type?: string | string[]
  $ref?: string
  properties?: Record<string, ExtendedSchema>
  required?: string[]
  items?: ExtendedSchema
  enum?: unknown[]
  description?: string
  format?: string
  const?: unknown
  additionalProperties?: boolean | ExtendedSchema
  contentMediaType?: string
  contentSchema?: ExtendedSchema
  oneOf?: ExtendedSchema[]
  discriminator?: { propertyName: string; mapping?: Record<string, string> }
  exclusiveMinimum?: number
  maximum?: number
  example?: unknown
}

/** Resolve a $ref string (e.g. "#/components/schemas/Foo") to its target schema. */
export function resolveRef(spec: OpenAPISpec, ref: string): ExtendedSchema {
  // Only handle local JSON Pointer refs: #/components/schemas/Name
  const prefix = '#/components/schemas/'
  if (!ref.startsWith(prefix)) {
    throw new Error(`Unsupported $ref: ${ref} (only local component refs supported)`)
  }
  const name = ref.slice(prefix.length)
  const schema = (spec.components?.schemas as Record<string, ExtendedSchema> | undefined)?.[name]
  if (!schema) {
    throw new Error(`$ref target not found: ${ref}`)
  }
  return schema
}

/** Check if a header param carries JSON content via OAS 3.1 contentMediaType. */
export function isJsonHeaderParam(param: OpenAPIParameter): boolean {
  const schema = param.schema as ExtendedSchema | undefined
  if (!schema) return false
  return schema.contentMediaType === 'application/json' && schema.contentSchema != null
}
