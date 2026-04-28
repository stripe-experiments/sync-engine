export type OpenApiSchemaObject = {
  type?: string
  format?: string
  required?: string[]
  nullable?: boolean
  properties?: Record<string, OpenApiSchemaOrReference>
  items?: OpenApiSchemaOrReference
  oneOf?: OpenApiSchemaOrReference[]
  anyOf?: OpenApiSchemaOrReference[]
  allOf?: OpenApiSchemaOrReference[]
  enum?: unknown[]
  additionalProperties?: boolean | OpenApiSchemaOrReference
  'x-resourceId'?: string
  'x-expandableFields'?: string[]
  'x-expansionResources'?: {
    oneOf?: OpenApiSchemaOrReference[]
  }
  'x-stripeEvent'?: { type?: string }
}

export type OpenApiReferenceObject = {
  $ref: string
}

export type OpenApiSchemaOrReference = OpenApiSchemaObject | OpenApiReferenceObject

export type OpenApiResponseContent = {
  schema?: OpenApiSchemaObject
}

export type OpenApiResponse = {
  content?: {
    'application/json'?: OpenApiResponseContent
  }
}

export type OpenApiOperationObject = {
  operationId?: string
  description?: string
  deprecated?: boolean
  parameters?: {
    name?: string
    in?: string
    required?: boolean
    schema?: OpenApiSchemaOrReference
  }[]
  responses?: Record<string, OpenApiResponse>
}

export type OpenApiPathItem = {
  get?: OpenApiOperationObject
  put?: OpenApiOperationObject
  post?: OpenApiOperationObject
  delete?: OpenApiOperationObject
  options?: OpenApiOperationObject
  head?: OpenApiOperationObject
  patch?: OpenApiOperationObject
  trace?: OpenApiOperationObject
}

export type OpenApiSpec = {
  openapi: string
  info?: {
    version?: string
  }
  paths?: Record<string, OpenApiPathItem>
  components?: {
    schemas?: Record<string, OpenApiSchemaOrReference>
  }
}

export type ScalarType = 'text' | 'boolean' | 'bigint' | 'numeric' | 'json' | 'timestamptz'
export type JsonShape = 'object' | 'array' | 'any'

export type ParsedColumn = {
  name: string
  type: ScalarType
  jsonShape?: JsonShape
  nullable: boolean
  expandableReference?: boolean
  expansionResourceIds?: string[]
}

export type ParsedResourceTable = {
  tableName: string
  resourceId: string
  sourceSchemaName: string
  columns: ParsedColumn[]
}

export type ParsedOpenApiSpec = {
  apiVersion: string
  tables: ParsedResourceTable[]
}

export type ParseSpecOptions = {
  /**
   * Map Stripe x-resourceId values to concrete Postgres table names.
   * Entries are matched case-sensitively.
   */
  resourceAliases?: Record<string, string>
  /**
   * Restrict parsing to these table names.
   * If omitted, every schema with x-resourceId is projected.
   */
  allowedTables?: string[]
  /**
   * Table names to exclude from parsing, even if discovered or allowed.
   * Used to avoid collisions with tables managed outside of the OpenAPI adapter
   * (e.g. the bootstrap `_accounts` table).
   */
  excludedTables?: string[]
}

export type ResolveSpecConfig = {
  apiVersion: string
  openApiSpecPath?: string
  cacheDir?: string
}

export type ResolvedOpenApiSpec = {
  apiVersion: string
  spec: OpenApiSpec
  source: 'explicit_path' | 'cache' | 'cdn' | 'github' | 'bundled'
  cachePath?: string
  commitSha?: string
}
