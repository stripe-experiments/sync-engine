import type { ListFn, RetrieveFn, ParsedResourceTable } from '@stripe/sync-openapi'

/**
 * Simple logger interface compatible with both pino and console
 */
export interface Logger {
  info(message?: unknown, ...optionalParams: unknown[]): void
  warn(message?: unknown, ...optionalParams: unknown[]): void
  error(message?: unknown, ...optionalParams: unknown[]): void
}

/**
 * Syncable resource configuration
 */
export type BaseResourceConfig = {
  /** Backfill order: lower numbers sync first; parents before children for FK dependencies */
  order: number
  /** Database table name for this resource (e.g. 'customer', 'invoice') */
  tableName: string
  /** Whether this resource supports incremental sync via 'created' filter or cursor */
  supportsCreatedFilter: boolean
  /** Whether this resource is included in sync runs by default. Default: true */
  sync?: boolean
  /** Resource types that must be backfilled before this one (e.g. price depends on product) */
  dependencies?: readonly string[]
}

export type ResourceConfig = BaseResourceConfig & {
  listFn?: ListFn
  retrieveFn?: RetrieveFn
  /** Parsed OpenAPI schema for this resource (used to build catalog json_schema) */
  parsedTable?: ParsedResourceTable
  /** Whether the list API supports the `limit` parameter */
  supportsLimit?: boolean
  /** Whether the list API supports forward cursor pagination for repeated page fetches. */
  supportsForwardPagination?: boolean
  /** Nested child resources discovered from the spec (e.g. subscription items under subscriptions) */
  nestedResources?: {
    tableName: string
    resourceId: string
    apiPath: string
    parentParamName: string
    supportsPagination: boolean
  }[]
  /** For nested resources, the parent path parameter name */
  parentParamName?: string
}
