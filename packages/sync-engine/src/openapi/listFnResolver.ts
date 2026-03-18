import type Stripe from 'stripe'
import type { OpenApiSchemaObject, OpenApiSpec } from './types'
import { OPENAPI_RESOURCE_TABLE_ALIASES } from './runtimeMappings'

const SCHEMA_REF_PREFIX = '#/components/schemas/'

type ListFn = (
  params: Stripe.PaginationParams & { created?: Stripe.RangeQueryParam }
) => Promise<{ data: unknown[]; has_more: boolean; pageCursor?: string }>

export type ListEndpoint = {
  tableName: string
  resourceId: string
  apiPath: string
}

export type NestedEndpoint = {
  tableName: string
  resourceId: string
  apiPath: string
  parentTableName: string
  parentParamName: string
  supportsPagination: boolean
}

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
}

function resolveTableName(resourceId: string, aliases: Record<string, string>): string {
  const alias = aliases[resourceId]
  if (alias) return alias
  const normalized = resourceId.toLowerCase().replace(/[.]/g, '_')
  return normalized.endsWith('s') ? normalized : `${normalized}s`
}

/**
 * Detect whether a response schema describes a list endpoint.
 * v1 lists have `object: enum ["list"]` with a `data` array.
 * v2 lists have a `data` array with `next_page_url`.
 */
function isListResponseSchema(schema: OpenApiSchemaObject): boolean {
  const dataProp = schema.properties?.data
  if (!dataProp || !('type' in dataProp) || dataProp.type !== 'array') return false

  const objectProp = schema.properties?.object
  if (objectProp && 'enum' in objectProp && objectProp.enum?.includes('list')) return true

  if (schema.properties?.next_page_url) return true

  return false
}

/**
 * Scan the spec for list endpoints (GET paths that return a Stripe list object)
 * and return one entry per table. Prefers top-level paths over nested ones.
 * Supports both v1 (object: "list") and v2 (next_page_url) response formats.
 */
export function discoverListEndpoints(
  spec: OpenApiSpec,
  aliases: Record<string, string> = OPENAPI_RESOURCE_TABLE_ALIASES
): Map<string, ListEndpoint> {
  const endpoints = new Map<string, ListEndpoint>()
  const paths = spec.paths
  if (!paths) return endpoints

  for (const [apiPath, pathItem] of Object.entries(paths)) {
    if (apiPath.includes('{')) continue

    const getOp = pathItem.get
    if (!getOp?.responses) continue

    const responseSchema = getOp.responses['200']?.content?.['application/json']?.schema
    if (!responseSchema) continue

    if (!isListResponseSchema(responseSchema)) continue

    const dataProp = responseSchema.properties?.data
    if (!dataProp || !('type' in dataProp) || dataProp.type !== 'array') continue

    const itemsRef = dataProp.items
    if (!itemsRef || !('$ref' in itemsRef) || typeof itemsRef.$ref !== 'string') continue
    if (!itemsRef.$ref.startsWith(SCHEMA_REF_PREFIX)) continue

    const schemaName = itemsRef.$ref.slice(SCHEMA_REF_PREFIX.length)
    const schema = spec.components?.schemas?.[schemaName]
    if (!schema || '$ref' in schema) continue

    const resourceId = schema['x-resourceId']
    if (!resourceId || typeof resourceId !== 'string') continue

    const tableName = resolveTableName(resourceId, aliases)
    if (!endpoints.has(tableName)) {
      endpoints.set(tableName, { tableName, resourceId, apiPath })
    }
  }

  return endpoints
}

/**
 * Scan the spec for nested list endpoints (paths with `{param}` segments that
 * return a Stripe list object) and map each to its parent resource.
 */
export function discoverNestedEndpoints(
  spec: OpenApiSpec,
  topLevelEndpoints: Map<string, ListEndpoint>,
  aliases: Record<string, string> = OPENAPI_RESOURCE_TABLE_ALIASES
): NestedEndpoint[] {
  const nested: NestedEndpoint[] = []
  const paths = spec.paths
  if (!paths) return nested

  const topLevelByPath = new Map<string, ListEndpoint>()
  for (const endpoint of topLevelEndpoints.values()) {
    topLevelByPath.set(endpoint.apiPath, endpoint)
  }

  for (const [apiPath, pathItem] of Object.entries(paths)) {
    if (!apiPath.includes('{')) continue

    const getOp = pathItem.get
    if (!getOp?.responses) continue

    const responseSchema = getOp.responses['200']?.content?.['application/json']?.schema
    if (!responseSchema) continue

    if (!isListResponseSchema(responseSchema)) continue

    const dataProp = responseSchema.properties?.data
    if (!dataProp || !('type' in dataProp) || dataProp.type !== 'array') continue

    const itemsRef = dataProp.items
    if (!itemsRef || !('$ref' in itemsRef) || typeof itemsRef.$ref !== 'string') continue
    if (!itemsRef.$ref.startsWith(SCHEMA_REF_PREFIX)) continue

    const schemaName = itemsRef.$ref.slice(SCHEMA_REF_PREFIX.length)
    const schema = spec.components?.schemas?.[schemaName]
    if (!schema || '$ref' in schema) continue

    const resourceId = schema['x-resourceId']
    if (!resourceId || typeof resourceId !== 'string') continue

    const paramMatch = apiPath.match(/\{([^}]+)\}/)
    if (!paramMatch) continue
    const parentParamName = paramMatch[1]

    const parentPath = apiPath.slice(0, apiPath.indexOf('/{'))
    const parentEndpoint = topLevelByPath.get(parentPath)
    if (!parentEndpoint) continue

    const params = getOp.parameters ?? []
    const supportsPagination = params.some((p: { name?: string }) => p.name === 'limit')

    nested.push({
      tableName: resolveTableName(resourceId, aliases),
      resourceId,
      apiPath,
      parentTableName: parentEndpoint.tableName,
      parentParamName,
      supportsPagination,
    })
  }

  return nested
}

export function isV2Path(apiPath: string): boolean {
  return apiPath.startsWith('/v2/')
}

function pathToSdkSegments(apiPath: string): string[] {
  if (isV2Path(apiPath)) {
    return [
      'v2',
      ...apiPath
        .replace(/^\/v2\//, '')
        .split('/')
        .filter((s) => !s.startsWith('{'))
        .map(snakeToCamel),
    ]
  }
  return apiPath
    .replace(/^\/v[12]\//, '')
    .split('/')
    .filter((s) => !s.startsWith('{'))
    .map(snakeToCamel)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveStripeResource(stripe: Stripe, segments: string[], apiPath: string): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let resource: any = stripe
  for (const segment of segments) {
    resource = resource?.[segment]
    if (!resource) {
      throw new Error(`Stripe SDK has no property "${segment}" when resolving path "${apiPath}"`)
    }
  }
  return resource
}

/**
 * Check whether an API path can be resolved to a Stripe SDK resource.
 * v1 requires both `.list()` and `.retrieve()`.
 * v2 only requires `.list()` (retrieve may not be available on all v2 resources).
 */
export function canResolveSdkResource(stripe: Stripe, apiPath: string): boolean {
  try {
    const segments = pathToSdkSegments(apiPath)
    const resource = resolveStripeResource(stripe, segments, apiPath)
    if (isV2Path(apiPath)) {
      return typeof resource.list === 'function'
    }
    return typeof resource.list === 'function' && typeof resource.retrieve === 'function'
  } catch {
    return false
  }
}

/**
 * Build a callable list function by navigating the Stripe SDK object using
 * the API path segments converted from snake_case to camelCase.
 * Path parameters (e.g. `{customer}`) are stripped automatically.
 */
export function buildListFn(stripe: Stripe, apiPath: string, apiKey: string): ListFn {
  const v2 = isV2Path(apiPath)
  if (v2) {
    return buildV2ListFn(apiKey, apiPath)
  }
  const segments = pathToSdkSegments(apiPath)
  return (params) => {
    const resource = resolveStripeResource(stripe, segments, apiPath)
    if (typeof resource.list !== 'function') {
      throw new Error(`Stripe SDK resource at "${apiPath}" has no list() method`)
    }
    return resource.list(params)
  }
}

type RetrieveFn = (id: string) => Promise<Stripe.Response<unknown>>

/**
 * Build a callable retrieve function by navigating the Stripe SDK object using
 * the API path segments converted from snake_case to camelCase.
 * Path parameters (e.g. `{customer}`) are stripped automatically.
 */
export function buildRetrieveFn(stripe: Stripe, apiPath: string, apiKey: string): RetrieveFn {
  const v2 = isV2Path(apiPath)
  if (v2) {
    return buildV2RetrieveFn(apiKey, apiPath)
  }
  const segments = pathToSdkSegments(apiPath)
  return (id: string) => {
    const resource = resolveStripeResource(stripe, segments, apiPath)
    if (typeof resource.retrieve !== 'function') {
      throw new Error(`Stripe SDK resource at "${apiPath}" has no retrieve() method`)
    }
    return resource.retrieve(id)
  }
}

/**
 * Build a list function that calls Stripe rawRequest directly for a fixed endpoint.
 * Useful when the Stripe SDK does not expose a matching namespace.
 */
export function buildRawRequestListFn(stripe: Stripe, apiPath: string): ListFn {
  return (params) =>
    stripe.rawRequest('GET', apiPath, params) as unknown as Promise<{
      data: unknown[]
      has_more: boolean
    }>
}

function extractPageToken(nextPageUrl: string | null | undefined): string | undefined {
  if (!nextPageUrl) return undefined
  try {
    const url = new URL(nextPageUrl, 'https://api.stripe.com')
    return url.searchParams.get('page') ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Build a list function for v2 API endpoints.
 * V2 uses `page` token pagination and returns `next_page_url` instead of `has_more`.
 * The response is normalized to the v1 shape so the sync worker can process it uniformly.
 */
export function buildV2ListFn(apiKey: string, apiPath: string): ListFn {
  return async (params) => {
    const qs = new URLSearchParams()
    qs.set('limit', String(Math.min(params.limit ?? 20, 20)))
    if (params.starting_after) qs.set('page', params.starting_after)
    const url = `https://api.stripe.com${apiPath}?${qs.toString()}`
    console.log('[v2-list] GET', url)
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Stripe-Version': '2026-02-25.clover',
      },
    })
    console.log('[v2-list] status:', response.status)
    const raw = await response.text()
    console.log('[v2-list] body:', raw.slice(0, 1000))
    const body = JSON.parse(raw) as {
      data: unknown[]
      next_page_url?: string | null
    }
    const nextToken = extractPageToken(body.next_page_url)
    return {
      data: body.data ?? [],
      has_more: !!body.next_page_url,
      pageCursor: nextToken,
    }
  }
}

export function buildV2RetrieveFn(apiKey: string, apiPath: string): RetrieveFn {
  return async (id: string) => {
    const response = await fetch(`https://api.stripe.com${apiPath}/${id}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Stripe-Version': '2026-02-25.clover',
      },
    })
    return (await response.json()) as Stripe.Response<unknown>
  }
}
