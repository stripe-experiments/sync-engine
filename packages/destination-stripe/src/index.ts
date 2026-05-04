import { createHash } from 'node:crypto'
import type { ConfiguredCatalog, Destination, Stream } from '@stripe/sync-protocol'
import { createSourceMessageFactory } from '@stripe/sync-protocol'
import {
  OPENAPI_RESOURCE_TABLE_ALIASES,
  resolveOpenApiSpec,
  resolveTableName,
  SpecParser,
} from '@stripe/sync-openapi'
import defaultSpec, { configSchema, type Config } from './spec.js'
import { log } from './logger.js'

export { configSchema, type Config } from './spec.js'

type FetchFn = typeof globalThis.fetch

export type StripeDestinationDeps = {
  fetch?: FetchFn
  sleep?: (ms: number) => Promise<void>
}

type StripeCustomer = {
  id: string
  object: 'customer'
  metadata?: Record<string, string>
  [key: string]: unknown
}

type StripeList<T> = {
  object: 'list' | 'search_result'
  data: T[]
  has_more?: boolean
}

class StripeWriteError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly responseHeaders?: Record<string, string>
  ) {
    super(message)
    this.name = 'StripeWriteError'
  }
}

const DEFAULT_STRIPE_API_BASE = 'https://api.stripe.com'
const SUPPORTED_STRIPE_OBJECT = 'customer'
const msg = createSourceMessageFactory<unknown, Record<string, unknown>, Record<string, unknown>>()

type StripeObjectReadPaths = {
  tableName: string
  searchPath: string
}

function baseUrl(config: Config): string {
  return (config.base_url ?? DEFAULT_STRIPE_API_BASE).replace(/\/$/, '')
}

function unsupportedObjectError(config: Config): Error | undefined {
  if (config.object === SUPPORTED_STRIPE_OBJECT) return undefined
  return new Error(
    `destination-stripe currently supports writing only Stripe Customers; object "${config.object}" is not supported`
  )
}

async function resolveReadPaths(config: Config, fetchFn: FetchFn): Promise<StripeObjectReadPaths> {
  const unsupported = unsupportedObjectError(config)
  if (unsupported) throw unsupported

  const resolved = await resolveOpenApiSpec({ apiVersion: config.api_version }, fetchFn)
  const parser = new SpecParser()
  const tableName = resolveTableName(config.object, OPENAPI_RESOURCE_TABLE_ALIASES)
  const operation = parser
    .discoverResourceOperations(resolved.spec)
    .get(tableName)
    ?.find((op) => op.methodName === 'search' && op.operation === 'get')

  if (!operation) {
    throw new Error(
      `OpenAPI spec for ${resolved.apiVersion} does not expose a Customer search operation`
    )
  }

  return { tableName, searchPath: operation.path }
}

function encodeFormData(params: Record<string, unknown>, prefix = ''): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(params)) {
    const fullKey = prefix ? `${prefix}[${key}]` : key
    if (value == null) continue
    if (typeof value === 'object' && !Array.isArray(value)) {
      parts.push(encodeFormData(value as Record<string, unknown>, fullKey))
    } else if (Array.isArray(value)) {
      for (const item of value) {
        parts.push(`${encodeURIComponent(`${fullKey}[]`)}=${encodeURIComponent(String(item))}`)
      }
    } else {
      parts.push(`${encodeURIComponent(fullKey)}=${encodeURIComponent(String(value))}`)
    }
  }
  return parts.filter(Boolean).join('&')
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value
  })
  return out
}

function errorMessageFromJson(json: unknown): string {
  if (
    json &&
    typeof json === 'object' &&
    'error' in json &&
    json.error &&
    typeof json.error === 'object' &&
    'message' in json.error
  ) {
    return String(json.error.message)
  }
  return 'Stripe request failed'
}

function retryAfterMs(headers: Record<string, string>): number | undefined {
  const value = headers['retry-after']
  if (!value) return undefined
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined
  return seconds * 1000
}

function isRetryable(err: unknown): boolean {
  if (err instanceof StripeWriteError) {
    return err.status === 429 || (err.status != null && err.status >= 500)
  }
  if (!(err instanceof Error)) return false
  if (err.name === 'AbortError') return false
  return err.name === 'TimeoutError' || /fetch failed|network|timeout/i.test(err.message)
}

async function requestJson<T>(
  config: Config,
  fetchFn: FetchFn,
  method: string,
  path: string,
  params?: Record<string, unknown>,
  opts?: { idempotencyKey?: string }
): Promise<T> {
  const url = new URL(path, baseUrl(config))
  let body: string | undefined

  if (method === 'GET' && params) {
    for (const [key, value] of Object.entries(params)) {
      if (value != null) url.searchParams.set(key, String(value))
    }
  } else if (params) {
    body = encodeFormData(params)
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.api_key}`,
    'Content-Type': 'application/x-www-form-urlencoded',
    'Stripe-Version': config.api_version,
  }
  if (opts?.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey

  const response = await fetchFn(url, { method, headers, body })
  const responseHeaders = headersToRecord(response.headers)
  const text = await response.text()
  const json = text ? JSON.parse(text) : {}

  if (!response.ok) {
    throw new StripeWriteError(errorMessageFromJson(json), response.status, responseHeaders)
  }

  return json as T
}

async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { maxRetries: number; sleep: (ms: number) => Promise<void>; label: string }
): Promise<T> {
  let delayMs = 1000
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (attempt >= opts.maxRetries || !isRetryable(err)) throw err
      const headers = err instanceof StripeWriteError ? err.responseHeaders : undefined
      const waitMs = headers ? (retryAfterMs(headers) ?? delayMs) : delayMs
      log.warn(
        {
          attempt: attempt + 1,
          max_retries: opts.maxRetries,
          delay_ms: waitMs,
          label: opts.label,
          err,
        },
        `Retrying Stripe write ${opts.label}`
      )
      await opts.sleep(waitMs)
      delayMs = Math.min(delayMs * 2, 32_000)
    }
  }
}

function getPath(data: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.')
  let current: unknown = data
  for (const part of parts) {
    if (!current || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

function setStripeParam(params: Record<string, unknown>, stripeField: string, value: unknown) {
  if (value == null) return
  const metadataMatch = /^metadata\[(.+)\]$/.exec(stripeField)
  if (metadataMatch) {
    const metadata = (params.metadata ?? {}) as Record<string, string>
    metadata[metadataMatch[1]!] = String(value)
    params.metadata = metadata
    return
  }
  params[stripeField] = value
}

function mappedParams(config: Config, data: Record<string, unknown>): Record<string, unknown> {
  const params: Record<string, unknown> = {}
  for (const [stripeField, sourceField] of Object.entries(config.fields)) {
    setStripeParam(params, stripeField, getPath(data, sourceField))
  }

  const externalId = getPath(data, config.identity.external_id_field)
  if (externalId != null) {
    const metadata = (params.metadata ?? {}) as Record<string, string>
    metadata[config.identity.metadata_key] = String(externalId)
    metadata.reverse_etl_source = 'sync-engine'
    params.metadata = metadata
  }

  return params
}

function stringValue(value: unknown): string | undefined {
  if (value == null || value === '') return undefined
  return String(value)
}

function streamFor(catalog: ConfiguredCatalog, name: string): Stream | undefined {
  return catalog.streams.find((configured) => configured.stream.name === name)?.stream
}

function idempotencyKey(
  stream: Stream | undefined,
  streamName: string,
  operation: string,
  data: Record<string, unknown>
): string {
  const pk = stream?.primary_key?.map((path) => getPath(data, path.join('.'))) ?? [data.id]
  const version = stream?.newer_than_field ? getPath(data, stream.newer_than_field) : undefined
  const raw = JSON.stringify({ stream: streamName, operation, pk, version })
  return `reverse-etl-${createHash('sha256').update(raw).digest('hex')}`
}

function stripeCustomerId(config: Config, data: Record<string, unknown>): string | undefined {
  const field = config.identity.stripe_id_field
  return field ? stringValue(getPath(data, field)) : undefined
}

async function findCustomerByExternalId(
  config: Config,
  fetchFn: FetchFn,
  readPaths: StripeObjectReadPaths,
  externalId: string
): Promise<StripeCustomer | undefined> {
  const query = `metadata['${config.identity.metadata_key}']:'${externalId.replace(/'/g, "\\'")}'`
  const result = await requestJson<StripeList<StripeCustomer>>(
    config,
    fetchFn,
    'GET',
    readPaths.searchPath,
    {
      query,
      limit: 2,
    }
  )
  if (result.data.length > 1) {
    throw new Error(
      `Ambiguous Stripe Customer identity for metadata ${config.identity.metadata_key}=${externalId}`
    )
  }
  return result.data[0]
}

async function upsertCustomer(
  config: Config,
  fetchFn: FetchFn,
  sleep: (ms: number) => Promise<void>,
  readPaths: StripeObjectReadPaths,
  stream: Stream | undefined,
  streamName: string,
  data: Record<string, unknown>
): Promise<StripeCustomer> {
  const params = mappedParams(config, data)
  const explicitCustomerId = stripeCustomerId(config, data)

  // Customer writes stay explicit for the MVP. Future object support should derive
  // create/update endpoints and writable params from OpenAPI operations directly.
  if (explicitCustomerId) {
    return await withRetry(
      () =>
        requestJson<StripeCustomer>(
          config,
          fetchFn,
          'POST',
          `/v1/customers/${encodeURIComponent(explicitCustomerId)}`,
          params,
          { idempotencyKey: idempotencyKey(stream, streamName, 'update', data) }
        ),
      { maxRetries: config.max_retries, sleep, label: `update customer ${explicitCustomerId}` }
    )
  }

  const externalId = stringValue(getPath(data, config.identity.external_id_field))
  if (!externalId) {
    throw new Error(`Missing external identity field "${config.identity.external_id_field}"`)
  }

  const existing = await withRetry(
    () => findCustomerByExternalId(config, fetchFn, readPaths, externalId),
    {
      maxRetries: config.max_retries,
      sleep,
      label: `search customer ${externalId}`,
    }
  )
  if (existing) {
    return await withRetry(
      () =>
        requestJson<StripeCustomer>(
          config,
          fetchFn,
          'POST',
          `/v1/customers/${encodeURIComponent(existing.id)}`,
          params,
          { idempotencyKey: idempotencyKey(stream, streamName, 'update', data) }
        ),
      { maxRetries: config.max_retries, sleep, label: `update customer ${existing.id}` }
    )
  }

  if (!config.allow_create) {
    throw new Error(
      `No Stripe Customer found for external identity ${externalId}; allow_create is false`
    )
  }

  return await withRetry(
    () =>
      requestJson<StripeCustomer>(config, fetchFn, 'POST', '/v1/customers', params, {
        idempotencyKey: idempotencyKey(stream, streamName, 'create', data),
      }),
    { maxRetries: config.max_retries, sleep, label: `create customer ${externalId}` }
  )
}

function streamError(stream: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return msg.stream_status({ stream, status: 'error', error: message })
}

export function createStripeDestination(deps: StripeDestinationDeps = {}): Destination<Config> {
  const fetchFn = deps.fetch ?? globalThis.fetch
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  return {
    async *spec() {
      yield { type: 'spec' as const, spec: defaultSpec }
    },

    async *check({ config }) {
      try {
        await resolveReadPaths(config, fetchFn)
        await requestJson(config, fetchFn, 'GET', '/v1/account')
        yield msg.connection_status({ status: 'succeeded' })
      } catch (err) {
        yield msg.connection_status({
          status: 'failed',
          message: err instanceof Error ? err.message : String(err),
        })
      }
    },

    async *write({ config, catalog }, $stdin) {
      const failedStreams = new Set<string>()
      let readPaths: StripeObjectReadPaths | undefined
      let setupError: unknown

      try {
        readPaths = await resolveReadPaths(config, fetchFn)
      } catch (err) {
        setupError = err
      }

      for await (const input of $stdin) {
        if (input.type === 'record') {
          const { stream, data } = input.record
          if (failedStreams.has(stream)) continue

          try {
            if (setupError) throw setupError
            await upsertCustomer(
              config,
              fetchFn,
              sleep,
              readPaths!,
              streamFor(catalog, stream),
              stream,
              data as Record<string, unknown>
            )
            yield input
          } catch (err) {
            failedStreams.add(stream)
            log.error({ stream, err }, 'destination-stripe write failed')
            yield streamError(stream, err)
          }
        } else if (input.type === 'source_state') {
          if (
            input.source_state.state_type === 'stream' &&
            failedStreams.has(input.source_state.stream)
          ) {
            continue
          }
          yield input
        } else {
          yield input
        }
      }
    },
  }
}

export default createStripeDestination()
