/**
 * OpenAPI Parser Module
 *
 * Provides functionality for parsing Stripe OpenAPI specifications and extracting
 * schema information for dynamic table generation.
 *
 * @example
 * ```typescript
 * import { createOpenAPIParser } from './openapi'
 *
 * const parser = createOpenAPIParser()
 * await parser.loadSpec('/path/to/openapi.spec3.json')
 *
 * const customerSchema = parser.getObjectSchema('customer')
 * console.log(`Customer has ${customerSchema.properties.length} properties`)
 * ```
 */

// Type exports
export type {
  OpenAPIParser,
  ObjectSchema,
  PropertyDefinition,
  OpenAPIType,
  LoadedSpec,
  ResolverOptions,
  TypeMapper,
  ColumnDefinition,
  TableDefinition,
  PostgresType,
  IndexingOption,
} from './types'

// Implementation exports
export { StripeOpenAPIParser, createOpenAPIParser } from './parser'
export { ReferenceResolver, resolveReferences } from './resolver'
export { StripeTypeMapper, createTypeMapper } from './typeMapper'