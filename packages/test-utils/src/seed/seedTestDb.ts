import pg from 'pg'
import { DEFAULT_STORAGE_SCHEMA, ensureSchema, ensureObjectTable, upsertObjects } from '../db/storage.js'
import { validateQueryAgainstOpenApi } from '../openapi/filters.js'
import { resolveEndpointSet } from '../openapi/endpoints.js'
import { startDockerPostgres18, type DockerPostgres18Handle } from '../postgres/dockerPostgres18.js'
import { assertStripeMockAvailable, fetchStripeListPage } from '../stripe/listApi.js'
import { applyCreatedTimestampRange, resolveCreatedTimestampRange } from './createdTimestamps.js'
import { generateStubObjects } from './v2Stubs.js'
import { randomUUID } from 'node:crypto'

const DEFAULT_STRIPE_MOCK_URL = 'http://localhost:12111'

export type SeedTestDbOptions = {
  stripeMockUrl?: string
  postgresUrl?: string
  schema?: string
  apiVersion?: string
  openApiSpecPath?: string
  /** How many objects to seed per endpoint. Defaults to 20. */
  count?: number
  /** @deprecated Use `count` instead. */
  limitPerEndpoint?: number
  tables?: string[]
  globalFilters?: Record<string, string>
  /** Start of created timestamp range (unix timestamp or date string). End defaults to now. */
  createdStart?: string | number
  /** End of created timestamp range (unix timestamp or date string). Defaults to now. */
  createdEnd?: string | number
  fetchImpl?: typeof globalThis.fetch
}

export type SeedEndpointResult = {
  tableName: string
  fetched: number
  inserted: number
  skipped?: string
}

export type SeedSummary = {
  apiVersion: string
  postgresUrl: string
  schema: string
  createdRange?: { startUnix: number; endUnix: number }
  totalObjects: number
  results: SeedEndpointResult[]
  skipped: SeedEndpointResult[]
}

export async function seedTestDb(options: SeedTestDbOptions = {}): Promise<SeedSummary> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
  const stripeMockUrl = options.stripeMockUrl ?? process.env.STRIPE_MOCK_URL ?? DEFAULT_STRIPE_MOCK_URL
  const schema = options.schema ?? DEFAULT_STORAGE_SCHEMA
  const count = options.count ?? options.limitPerEndpoint ?? 20
  const createdRange = resolveCreatedTimestampRange({
    createdStart: options.createdStart,
    createdEnd: options.createdEnd,
  })
  const endpointSet = await resolveEndpointSet({
    apiVersion: options.apiVersion,
    openApiSpecPath: options.openApiSpecPath,
    fetchImpl,
  })

  let stripeMockAvailable = false
  try {
    await assertStripeMockAvailable(stripeMockUrl, fetchImpl)
    stripeMockAvailable = true
  } catch {
    process.stderr.write(`stripe-mock not available at ${stripeMockUrl} — using generated stubs for all endpoints\n`)
  }

  let connectionString: string
  if (options.postgresUrl) {
    connectionString = options.postgresUrl
    process.stderr.write(`Using Postgres: ${redactConnectionString(connectionString)}\n`)
  } else {
    process.stderr.write('Starting Docker postgres:18 container...\n')
    const dockerHandle = await startDockerPostgres18()
    process.stderr.write(`Docker postgres:18 ready on port ${dockerHandle.hostPort}\n`)
    connectionString = dockerHandle.connectionString
  }

  const pool = new pg.Pool({ connectionString })
  try {
    await ensureSchema(pool, schema)

    const selected =
      options.tables && options.tables.length > 0
        ? [...endpointSet.endpoints.values()].filter((endpoint) => options.tables?.includes(endpoint.tableName))
        : [...endpointSet.endpoints.values()]

    const PAGINATION_PARAMS = new Set(['limit', 'starting_after', 'ending_before', 'created', 'expand'])

    const results: SeedEndpointResult[] = []
    const skipped: SeedEndpointResult[] = []
    let totalObjects = 0
    for (const endpoint of selected.sort((a, b) => a.tableName.localeCompare(b.tableName))) {
      let rawRows: Record<string, unknown>[]

      if (!stripeMockAvailable || endpoint.isV2) {
        rawRows = generateStubObjects(endpoint, count)
      } else {
        const unsatisfiedRequired = endpoint.queryParams.filter(
          (p) => p.required && !PAGINATION_PARAMS.has(p.name) && !options.globalFilters?.[p.name]
        )
        if (unsatisfiedRequired.length > 0) {
          const names = unsatisfiedRequired.map((p) => p.name).join(', ')
          const reason = `requires unsatisfied params: ${names}`
          process.stderr.write(`  skip ${endpoint.tableName} — ${reason}\n`)
          skipped.push({ tableName: endpoint.tableName, fetched: 0, inserted: 0, skipped: reason })
          continue
        }

        const query = new URLSearchParams()
        if (options.globalFilters) {
          for (const [key, value] of Object.entries(options.globalFilters)) query.set(key, value)
        }
        if (!query.has('limit') && endpoint.queryParams.some((param) => param.name === 'limit')) {
          query.set('limit', String(count))
        }

        const validated = validateQueryAgainstOpenApi(query, endpoint.queryParams)
        if (!validated.ok) {
          const reason = validated.details.join('; ')
          process.stderr.write(`  skip ${endpoint.tableName} — validation: ${reason}\n`)
          skipped.push({ tableName: endpoint.tableName, fetched: 0, inserted: 0, skipped: reason })
          continue
        }

        let page
        try {
          page = await fetchStripeListPage(stripeMockUrl, endpoint, validated.forward, fetchImpl)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          process.stderr.write(`  skip ${endpoint.tableName} — stripe-mock error: ${message}\n`)
          skipped.push({ tableName: endpoint.tableName, fetched: 0, inserted: 0, skipped: message })
          continue
        }
        rawRows = replicateToCount(page.data, count)
      }

      const payloadRows = applyCreatedTimestampRange(rawRows, createdRange)
        .filter((obj) => typeof obj.id === 'string')
      await ensureObjectTable(pool, schema, endpoint.tableName, endpoint.jsonSchema)
      const inserted = await upsertObjects(pool, schema, endpoint.tableName, payloadRows)

      results.push({
        tableName: endpoint.tableName,
        fetched: payloadRows.length,
        inserted,
      })
      totalObjects += inserted
    }

    return {
      apiVersion: endpointSet.apiVersion,
      postgresUrl: connectionString,
      schema,
      createdRange,
      totalObjects,
      results,
      skipped,
    }
  } finally {
    await pool.end().catch(() => undefined)
  }
}

function redactConnectionString(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.password) parsed.password = '***'
    return parsed.toString()
  } catch {
    return url.replace(/:[^:@]+@/, ':***@')
  }
}

function replicateToCount(
  templates: Record<string, unknown>[],
  target: number
): Record<string, unknown>[] {
  if (templates.length === 0 || templates.length >= target) return templates
  const result = [...templates]
  while (result.length < target) {
    const template = templates[result.length % templates.length]
    const id = typeof template.id === 'string' ? template.id : ''
    const prefix = id.replace(/_[^_]+$/, '')
    const clone: Record<string, unknown> = {
      ...template,
      id: `${prefix}_seed${randomUUID().replace(/-/g, '').slice(0, 16)}`,
    }
    result.push(clone)
  }
  return result
}
