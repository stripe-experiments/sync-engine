import { createHash } from 'node:crypto'
import type { ConfiguredCatalog, Destination, Stream } from '@stripe/sync-protocol'
import { createSourceMessageFactory } from '@stripe/sync-protocol'
import { resolveOpenApiSpec, SpecParser, type CreateEndpoint } from '@stripe/sync-openapi'
import defaultSpec, {
  configSchema,
  type Config,
  type CustomObjectConfig,
  type StripeObjectConfig,
} from './spec.js'
import { log } from './logger.js'

export { configSchema, type Config } from './spec.js'

type FetchFn = typeof globalThis.fetch

export type StripeDestinationDeps = {
  fetch?: FetchFn
  sleep?: (ms: number) => Promise<void>
}

type RequestBodyEncoding = 'form' | 'json'

type CustomObjectStreamConfig = CustomObjectConfig['streams'][string]
type StripeObjectStreamConfig = StripeObjectConfig['streams'][string]
type StripeObjectSetup = {
  config: StripeObjectConfig
  createEndpoints: Map<string, CreateEndpoint>
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
const SUPPORTED_CUSTOM_OBJECT = 'custom_object'
const SUPPORTED_STRIPE_OBJECT = 'stripe_object'
const CUSTOM_OBJECT_API_VERSION = 'unsafe-development'
const msg = createSourceMessageFactory<unknown, Record<string, unknown>, Record<string, unknown>>()

function baseUrl(config: Config): string {
  return (config.base_url ?? DEFAULT_STRIPE_API_BASE).replace(/\/$/, '')
}

function requireCustomObjectConfig(config: Config): CustomObjectConfig {
  const raw = config as Config & {
    object?: unknown
    api_version?: unknown
    write_mode?: unknown
    streams?: unknown
  }
  if (raw.object !== SUPPORTED_CUSTOM_OBJECT) {
    throw new Error(
      `destination-stripe expected object: "custom_object"; object "${String(raw.object)}" is not supported by this write path`
    )
  }
  if (raw.api_version !== CUSTOM_OBJECT_API_VERSION) {
    throw new Error(
      `api_version must be "${CUSTOM_OBJECT_API_VERSION}" for object: "custom_object"`
    )
  }
  if (raw.write_mode !== 'create') {
    throw new Error('write_mode must be "create" for object: "custom_object"')
  }
  if (!isRecord(raw.streams) || Object.keys(raw.streams).length === 0) {
    throw new Error('streams is required for object: "custom_object"')
  }
  return config as CustomObjectConfig
}

function requireStripeObjectConfig(config: Config): StripeObjectConfig {
  const raw = config as Config & {
    object?: unknown
    write_mode?: unknown
    streams?: unknown
  }
  if (raw.object !== SUPPORTED_STRIPE_OBJECT) {
    throw new Error(
      `destination-stripe expected object: "stripe_object"; object "${String(raw.object)}" is not supported by this write path`
    )
  }
  if (raw.write_mode !== 'create') {
    throw new Error('write_mode must be "create" for object: "stripe_object"')
  }
  if (!isRecord(raw.streams) || Object.keys(raw.streams).length === 0) {
    throw new Error('streams is required for object: "stripe_object"')
  }
  return config as StripeObjectConfig
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
  opts?: { idempotencyKey?: string; bodyEncoding?: RequestBodyEncoding; stripeVersion?: string }
): Promise<T> {
  const url = new URL(path, baseUrl(config))
  let body: string | undefined

  if (method === 'GET' && params) {
    for (const [key, value] of Object.entries(params)) {
      if (value != null) url.searchParams.set(key, String(value))
    }
  } else if (params) {
    body = opts?.bodyEncoding === 'json' ? JSON.stringify(params) : encodeFormData(params)
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.api_key}`,
    'Stripe-Version': opts?.stripeVersion ?? config.api_version,
  }
  if (body !== undefined) {
    headers['Content-Type'] =
      opts?.bodyEncoding === 'json' ? 'application/json' : 'application/x-www-form-urlencoded'
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

type CustomObjectDefinition = Record<string, unknown>

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function objectRecords(value: unknown): CustomObjectDefinition[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

function extractCustomObjectDefinitions(json: unknown): CustomObjectDefinition[] {
  if (Array.isArray(json)) return objectRecords(json)
  if (!isRecord(json)) return []

  if (Array.isArray(json.data)) return objectRecords(json.data)
  if (Array.isArray(json.object_definitions)) return objectRecords(json.object_definitions)
  return []
}

function customObjectDefinitionPluralName(definition: CustomObjectDefinition): string | undefined {
  const pluralName =
    definition.api_name_plural ?? definition.plural_name ?? definition.pluralName ?? definition.name
  return typeof pluralName === 'string' ? pluralName : undefined
}

function customObjectFieldName(field: unknown): string | undefined {
  if (typeof field === 'string') return field
  if (!isRecord(field)) return undefined
  const name = field.name ?? field.key
  return typeof name === 'string' ? name : undefined
}

function customObjectFieldNames(definition: CustomObjectDefinition): Set<string> | undefined {
  const fields = definition.properties ?? definition.fields
  if (fields == null) return undefined

  if (Array.isArray(fields)) {
    return new Set(
      fields.map(customObjectFieldName).filter((name): name is string => Boolean(name))
    )
  }

  if (isRecord(fields)) {
    if (Array.isArray(fields.data)) {
      return new Set(
        fields.data.map(customObjectFieldName).filter((name): name is string => Boolean(name))
      )
    }
    return new Set(Object.keys(fields))
  }

  return undefined
}

async function validateCustomObjectConfig(config: Config, fetchFn: FetchFn): Promise<void> {
  const customConfig = requireCustomObjectConfig(config)
  const json = await requestJson<unknown>(
    customConfig,
    fetchFn,
    'GET',
    '/v2/extend/object_definitions',
    undefined,
    { stripeVersion: CUSTOM_OBJECT_API_VERSION }
  )
  const definitions = extractCustomObjectDefinitions(json)
  if (definitions.length === 0) {
    throw new Error(
      `No Stripe Custom Object definitions found; cannot validate configured custom object streams`
    )
  }

  const definitionsByPluralName = new Map(
    definitions
      .map((definition) => [customObjectDefinitionPluralName(definition), definition] as const)
      .filter((entry): entry is [string, CustomObjectDefinition] => entry[0] != null)
  )

  for (const [streamName, streamConfig] of Object.entries(customConfig.streams)) {
    const definition = definitionsByPluralName.get(streamConfig.plural_name)
    if (!definition) {
      throw new Error(
        `Stripe Custom Object definition "${streamConfig.plural_name}" for stream "${streamName}" was not found`
      )
    }

    const knownFields = customObjectFieldNames(definition)
    if (knownFields === undefined) continue

    const unknownFields = Object.keys(streamConfig.field_mapping).filter(
      (field) => !knownFields.has(field)
    )
    if (unknownFields.length > 0) {
      throw new Error(
        `Stripe Custom Object "${streamConfig.plural_name}" for stream "${streamName}" does not define mapped field(s): ${unknownFields.join(', ')}`
      )
    }
  }
}

async function validateStripeObjectConfig(
  config: Config,
  fetchFn: FetchFn
): Promise<StripeObjectSetup> {
  const stripeConfig = requireStripeObjectConfig(config)
  const resolved = await resolveOpenApiSpec({ apiVersion: stripeConfig.api_version }, fetchFn)
  const createEndpoints = new SpecParser().discoverCreateEndpoints(resolved.spec)

  for (const [streamName, streamConfig] of Object.entries(stripeConfig.streams)) {
    const endpoint = createEndpoints.get(streamName)
    if (!endpoint) {
      throw new Error(`Stripe create endpoint for stream "${streamName}" was not found`)
    }

    const unknownParams = Object.keys(streamConfig.field_mapping).filter(
      (stripeParam) => !endpoint.requestFields.has(stripeParam)
    )
    if (unknownParams.length > 0) {
      throw new Error(
        `Stripe object stream "${streamName}" does not define create parameter(s): ${unknownParams.join(', ')}`
      )
    }
  }

  return { config: stripeConfig, createEndpoints }
}

type DestinationSetup =
  | { object: 'custom_object'; config: CustomObjectConfig }
  | {
      object: 'stripe_object'
      config: StripeObjectConfig
      createEndpoints: Map<string, CreateEndpoint>
    }

async function validateConfig(config: Config, fetchFn: FetchFn): Promise<DestinationSetup> {
  const object = (config as { object?: unknown }).object
  if (object === SUPPORTED_CUSTOM_OBJECT) {
    await validateCustomObjectConfig(config, fetchFn)
    return { object: 'custom_object', config: requireCustomObjectConfig(config) }
  }
  if (object === SUPPORTED_STRIPE_OBJECT) {
    const setup = await validateStripeObjectConfig(config, fetchFn)
    return { object: 'stripe_object', ...setup }
  }
  throw new Error(
    `destination-stripe supports object: "custom_object" or "stripe_object"; object "${String(object)}" is not supported`
  )
}

function customObjectFields(
  streamConfig: CustomObjectStreamConfig,
  data: Record<string, unknown>
): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  for (const [customObjectField, sourceField] of Object.entries(streamConfig.field_mapping)) {
    const value = getPath(data, sourceField)
    if (value != null) fields[customObjectField] = value
  }
  return fields
}

function customObjectStreamConfig(
  config: CustomObjectConfig,
  streamName: string
): CustomObjectStreamConfig {
  const streamConfig = config.streams[streamName]
  if (!streamConfig) {
    throw new Error(`No Stripe Custom Object stream config found for stream "${streamName}"`)
  }
  return streamConfig
}

function stripeObjectStreamConfig(
  config: StripeObjectConfig,
  streamName: string
): StripeObjectStreamConfig {
  const streamConfig = config.streams[streamName]
  if (!streamConfig) {
    throw new Error(`No Stripe object stream config found for stream "${streamName}"`)
  }
  return streamConfig
}

function stripeObjectParams(
  endpoint: CreateEndpoint,
  streamConfig: StripeObjectStreamConfig,
  data: Record<string, unknown>
): Record<string, unknown> {
  const params: Record<string, unknown> = {}
  for (const [stripeParam, sourceField] of Object.entries(streamConfig.field_mapping)) {
    if (!endpoint.requestFields.has(stripeParam)) continue
    const value = getPath(data, sourceField)
    if (value != null) params[stripeParam] = value
  }
  return params
}

async function createCustomObject(
  config: CustomObjectConfig,
  streamConfig: CustomObjectStreamConfig,
  fetchFn: FetchFn,
  sleep: (ms: number) => Promise<void>,
  stream: Stream | undefined,
  streamName: string,
  data: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const params = { fields: customObjectFields(streamConfig, data) }
  const pluralName = encodeURIComponent(streamConfig.plural_name)
  const idemKey = idempotencyKey(stream, streamName, 'create', data)
  const record = await withRetry(
    () =>
      requestJson<Record<string, unknown>>(
        config,
        fetchFn,
        'POST',
        `/v2/extend/objects/${pluralName}`,
        params,
        {
          bodyEncoding: 'json',
          stripeVersion: CUSTOM_OBJECT_API_VERSION,
          idempotencyKey: idemKey,
        }
      ),
    {
      maxRetries: config.max_retries,
      sleep,
      label: `create custom object ${streamConfig.plural_name}`,
    }
  )
  if (typeof record.id !== 'string') {
    throw new Error(`Stripe Custom Object create response did not include a string id`)
  }
  return record
}

async function createStripeObject(
  setup: Extract<DestinationSetup, { object: 'stripe_object' }>,
  fetchFn: FetchFn,
  sleep: (ms: number) => Promise<void>,
  stream: Stream | undefined,
  streamName: string,
  data: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const endpoint = setup.createEndpoints.get(streamName)
  if (!endpoint) {
    throw new Error(`Stripe create endpoint for stream "${streamName}" was not found`)
  }
  const params = stripeObjectParams(
    endpoint,
    stripeObjectStreamConfig(setup.config, streamName),
    data
  )
  const idemKey = idempotencyKey(stream, streamName, 'create', data)
  const record = await withRetry(
    () =>
      requestJson<Record<string, unknown>>(
        setup.config,
        fetchFn,
        'POST',
        endpoint.apiPath,
        params,
        {
          bodyEncoding: endpoint.bodyEncoding,
          idempotencyKey: idemKey,
        }
      ),
    {
      maxRetries: setup.config.max_retries,
      sleep,
      label: `create Stripe object ${streamName}`,
    }
  )
  if (typeof record.id !== 'string') {
    throw new Error(
      `Stripe object create response for stream "${streamName}" did not include a string id`
    )
  }
  return record
}

function streamError(stream: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return msg.stream_status({ stream, status: 'error', error: message })
}

function connectionError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return msg.connection_status({ status: 'failed', message })
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
        await validateConfig(config, fetchFn)
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
      let setupError: unknown
      let setup: DestinationSetup | undefined
      let setupChecked = false

      for await (const input of $stdin) {
        if (!setupChecked) {
          setupChecked = true
          try {
            setup = await validateConfig(config, fetchFn)
          } catch (err) {
            setupError = err
            yield connectionError(err)
            for (const configured of catalog.streams) {
              failedStreams.add(configured.stream.name)
              yield streamError(configured.stream.name, err)
            }
          }
        }

        if (input.type === 'record') {
          const { stream, data } = input.record
          if (failedStreams.has(stream)) continue

          try {
            if (setupError) throw setupError
            if (!setup) throw new Error('destination-stripe setup did not complete')
            if (setup.object === 'custom_object') {
              await createCustomObject(
                setup.config,
                customObjectStreamConfig(setup.config, stream),
                fetchFn,
                sleep,
                streamFor(catalog, stream),
                stream,
                data as Record<string, unknown>
              )
            } else {
              await createStripeObject(
                setup,
                fetchFn,
                sleep,
                streamFor(catalog, stream),
                stream,
                data as Record<string, unknown>
              )
            }
            yield input
          } catch (err) {
            failedStreams.add(stream)
            log.error({ stream, err }, 'destination-stripe write failed')
            yield streamError(stream, err)
          }
        } else if (input.type === 'source_state') {
          if (setupError) {
            continue
          }
          if (input.source_state.state_type === 'global' && failedStreams.size > 0) {
            continue
          }
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
