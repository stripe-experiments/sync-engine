/**
 * TypeScript interfaces for OpenAPI parsing functionality
 *
 * These interfaces define the core types used for parsing Stripe OpenAPI specifications
 * and extracting schema information for dynamic table generation.
 */

export type OpenAPIType =
  | 'string'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'object'
  | 'array'
  | 'null'

/**
 * Definition of a property extracted from OpenAPI schema
 */
export interface PropertyDefinition {
  /** Property name as defined in the schema */
  name: string

  /** OpenAPI type of the property */
  type: OpenAPIType

  /** Whether the property is nullable */
  nullable: boolean

  /** Optional description from the schema */
  description?: string

  /** Original OpenAPI definition for complex cases */
  rawDefinition: any

  /** Format specifier (e.g., 'unix-time' for timestamps) */
  format?: string

  /** For arrays, the type of items in the array */
  itemType?: OpenAPIType

  /** For arrays of objects, the item definition */
  itemDefinition?: any
}

/**
 * Schema definition for a complete Stripe object
 */
export interface ObjectSchema {
  /** Object name (e.g., 'customer', 'charge') */
  name: string

  /** List of properties in this object */
  properties: PropertyDefinition[]

  /** Optional description of the object */
  description?: string

  /** Required properties according to the schema */
  required?: string[]
}

/**
 * Main interface for OpenAPI parser
 */
export interface OpenAPIParser {
  /** Load a spec from a file path */
  loadSpec(specPath: string): Promise<void>

  /** Load a spec from an already parsed object */
  loadSpecObject(spec: unknown): void

  /** Get schema for a specific Stripe object */
  getObjectSchema(objectName: string): ObjectSchema | null

  /** List all available object types in the spec */
  listObjectTypes(): string[]

  /** Get the API version from the spec */
  getApiVersion(): string

  /** Check if a spec is currently loaded */
  isLoaded(): boolean
}

/**
 * Internal representation of loaded OpenAPI spec
 */
export interface LoadedSpec {
  /** Raw OpenAPI specification object */
  spec: any

  /** API version from spec.info.version */
  version: string

  /** Available schema names */
  schemaNames: string[]
}

/**
 * Configuration for reference resolution
 */
export interface ResolverOptions {
  /** Maximum depth for resolving nested $ref references */
  maxDepth?: number

  /** Whether to follow circular references */
  followCircular?: boolean
}

/**
 * Postgres column types that we map to
 */
export type PostgresType =
  | 'text'
  | 'bigint'
  | 'numeric'
  | 'boolean'
  | 'jsonb'
  | 'text[]'

/**
 * Definition of a database column generated from OpenAPI property
 */
export interface ColumnDefinition {
  /** Column name (matches property name) */
  name: string

  /** Postgres data type */
  type: PostgresType

  /** Whether the column allows NULL values */
  nullable: boolean

  /** Whether this column is a primary key */
  primaryKey: boolean

  /** Optional description from OpenAPI schema */
  description?: string

  /** Available indexing strategies for this column */
  indexingOptions: IndexingOption[]
}

/**
 * Complete table definition derived from OpenAPI schema
 */
export interface TableDefinition {
  /** Table name (usually pluralized object name) */
  name: string

  /** All columns in the table */
  columns: ColumnDefinition[]

  /** Optional description of the table */
  description?: string
}

/**
 * Indexing recommendation for a column type
 */
export interface IndexingOption {
  /** Type of index (B-tree, GIN, etc.) */
  type: 'btree' | 'gin' | 'gist'

  /** Human-readable description of when to use this index */
  description: string

  /** SQL example for creating this type of index */
  example: string
}

/**
 * Main interface for mapping OpenAPI types to Postgres types
 */
export interface TypeMapper {
  /** Map an OpenAPI property to Postgres column definition */
  mapProperty(property: PropertyDefinition): ColumnDefinition

  /** Map an entire object schema to table definition */
  mapObjectSchema(schema: ObjectSchema): TableDefinition

  /** Get indexing recommendations for a column type */
  getIndexingOptions(columnType: PostgresType): IndexingOption[]
}