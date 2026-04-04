import http from 'node:http'
import type { AddressInfo } from 'node:net'
import pg from 'pg'
import { DEFAULT_STORAGE_SCHEMA, ensureSchema, quoteIdentifier } from '../db/storage.js'
import { resolveEndpointSet, type EndpointDefinition } from '../openapi/endpoints.js'
import { startDockerPostgres18, type DockerPostgres18Handle } from '../postgres/dockerPostgres18.js'

export type StripeListServerOptions = {
  port?: number
  host?: string
  apiVersion?: string
  openApiSpecPath?: string
  postgresUrl?: string
  schema?: string
  /** Unix timestamp for the fake account's `created` field. Controls backfill range start. */
  accountCreated?: number
  fetchImpl?: typeof globalThis.fetch
}

export type StripeListServer = {
  host: string
  port: number
  url: string
  postgresUrl: string
  postgresMode: 'docker' | 'external'
  close: () => Promise<void>
}

function makeFakeAccount(created: number) {
  return {
    id: 'acct_test_fake_000000',
    object: 'account',
    type: 'standard',
    charges_enabled: true,
    payouts_enabled: true,
    details_submitted: true,
    business_type: 'company',
    country: 'US',
    default_currency: 'usd',
    email: 'test@example.com',
    created,
    settings: { dashboard: { display_name: 'Test Account' } },
  }
}

export async function createStripeListServer(
  options: StripeListServerOptions = {}
): Promise<StripeListServer> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
  const schema = options.schema ?? DEFAULT_STORAGE_SCHEMA
  const endpointSet = await resolveEndpointSet({
    apiVersion: options.apiVersion,
    openApiSpecPath: options.openApiSpecPath,
    fetchImpl,
  })

  let dockerHandle: DockerPostgres18Handle | undefined
  let postgresMode: 'docker' | 'external' = 'external'
  const postgresUrl = options.postgresUrl ?? process.env.POSTGRES_URL
  if (!postgresUrl) {
    dockerHandle = await startDockerPostgres18()
    postgresMode = 'docker'
  }
  const connectionString = postgresUrl ?? dockerHandle?.connectionString
  if (!connectionString) {
    throw new Error('No Postgres connection string available')
  }

  const pool = new pg.Pool({ connectionString })
  await ensureSchema(pool, schema)

  const fakeAccount = makeFakeAccount(options.accountCreated ?? Math.floor(Date.now() / 1000))

  // API path → endpoint (for list routing)
  const pathToEndpoint = new Map<string, EndpointDefinition>()
  for (const ep of endpointSet.endpoints.values()) {
    pathToEndpoint.set(ep.apiPath, ep)
  }

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
    await pool.end().catch(() => undefined)
    if (dockerHandle) dockerHandle.stop()
  }

  const server = http.createServer(async (req, res) => {
    const method = req.method ?? 'GET'
    const url = req.url ?? '/'
    try {
      const base = `http://${req.headers.host ?? '127.0.0.1'}`
      const requestUrl = new URL(url, base)
      const { pathname } = requestUrl

      if (pathname.startsWith('/v1/') || pathname.startsWith('/v2/')) {
        if (method !== 'GET') {
          logRequest(method, url, 405)
          return sendJson(res, 405, {
            error: {
              type: 'invalid_request_error',
              message: 'Method not allowed',
            },
          })
        }

        // GET /v1/account — source-stripe calls this during setup
        if (pathname === '/v1/account') {
          logRequest(method, url, 200)
          return sendJson(res, 200, fakeAccount)
        }

        // Exact match → list endpoint
        const listEndpoint = pathToEndpoint.get(pathname)
        if (listEndpoint) {
          const status = await handleList(res, pool, schema, listEndpoint, requestUrl.searchParams)
          logRequest(method, url, status)
          return
        }

        // Parent path + trailing ID segment → retrieve
        const lastSlash = pathname.lastIndexOf('/')
        if (lastSlash > 0) {
          const parentPath = pathname.slice(0, lastSlash)
          const objectId = decodeURIComponent(pathname.slice(lastSlash + 1))
          const parentEndpoint = pathToEndpoint.get(parentPath)
          if (parentEndpoint && objectId) {
            const status = await handleRetrieve(res, pool, schema, parentEndpoint, objectId)
            logRequest(method, url, status)
            return
          }
        }

        logRequest(method, url, 404)
        return sendJson(res, 404, {
          error: {
            type: 'invalid_request_error',
            message: `Unrecognized request URL (GET: ${pathname})`,
          },
        })
      }

      if (method !== 'GET') {
        logRequest(method, url, 405)
        return sendJson(res, 405, { error: 'Method not allowed' })
      }

      if (pathname === '/health') {
        logRequest(method, url, 200)
        return sendJson(res, 200, {
          ok: true,
          api_version: endpointSet.apiVersion,
          endpoint_count: endpointSet.endpoints.size,
        })
      }

      if (pathname === '/db-health') {
        const probe = await pool.query('SELECT 1 AS ok')
        logRequest(method, url, 200)
        return sendJson(res, 200, {
          ok: probe.rows[0]?.ok === 1,
          postgres_mode: postgresMode,
          postgres_url: redactConnectionString(connectionString),
          schema,
        })
      }

      logRequest(method, url, 404)
      return sendJson(res, 404, { error: 'Not found' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logRequest(method, url, 500)
      return sendJson(res, 500, { error: message })
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 5555, options.host ?? '127.0.0.1', () => resolve())
  })

  const address = server.address() as AddressInfo
  if (!address || typeof address.port !== 'number') {
    await close()
    throw new Error('Failed to resolve listening address for test server')
  }

  const serverHost = options.host ?? '127.0.0.1'
  const cleanup = () => {
    void close()
  }
  process.once('SIGINT', cleanup)
  process.once('SIGTERM', cleanup)

  return {
    host: serverHost,
    port: address.port,
    url: `http://${serverHost}:${address.port}`,
    postgresUrl: connectionString,
    postgresMode,
    close,
  }
}

// ---------------------------------------------------------------------------
// List — paginated read from Postgres, returns Stripe list response format
// ---------------------------------------------------------------------------

async function handleList(
  res: http.ServerResponse,
  pool: pg.Pool,
  schema: string,
  endpoint: EndpointDefinition,
  search: URLSearchParams
): Promise<number> {
  if (endpoint.isV2) {
    const limit = clampLimit(search.get('limit'), 20)
    const pageToken = search.get('page') ?? undefined
    const afterId = pageToken ? decodePageToken(pageToken) : undefined

    const { data, hasMore, lastId } = await queryPageV2(pool, schema, endpoint.tableName, {
      limit,
      afterId,
    })

    const nextPageUrl =
      hasMore && lastId
        ? buildV2NextPageUrl(endpoint.apiPath, limit, encodePageToken(lastId), search)
        : null

    sendJson(res, 200, {
      data,
      next_page_url: nextPageUrl,
      previous_page_url: null,
    })
    return 200
  }

  // expand / expand[] query params are ignored — responses are already full JSON
  // blobs from seeding; accepting the params avoids spurious validation errors.
  const limit = clampLimit(search.get('limit'), 10)
  const { data, hasMore } = await queryPageV1(pool, schema, endpoint.tableName, {
    limit,
    afterId: search.get('starting_after') ?? undefined,
    beforeId: search.get('ending_before') ?? undefined,
    createdGt: parseIntParam(search.get('created[gt]')),
    createdGte: parseIntParam(search.get('created[gte]')),
    createdLt: parseIntParam(search.get('created[lt]')),
    createdLte: parseIntParam(search.get('created[lte]')),
  })

  sendJson(res, 200, {
    object: 'list',
    url: endpoint.apiPath,
    has_more: hasMore,
    data,
  })
  return 200
}

// ---------------------------------------------------------------------------
// Retrieve — single object by ID from Postgres
// ---------------------------------------------------------------------------

async function handleRetrieve(
  res: http.ServerResponse,
  pool: pg.Pool,
  schema: string,
  endpoint: EndpointDefinition,
  objectId: string
): Promise<number> {
  const q = quoteIdentifier
  let rows: { _raw_data: Record<string, unknown> }[]
  try {
    const result = await pool.query(
      `SELECT _raw_data FROM ${q(schema)}.${q(endpoint.tableName)} WHERE id = $1 LIMIT 1`,
      [objectId]
    )
    rows = result.rows
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === '42P01') {
      rows = []
    } else {
      throw err
    }
  }

  if (rows.length === 0) {
    sendJson(res, 404, {
      error: {
        type: 'invalid_request_error',
        message: `No such ${endpoint.resourceId}: '${objectId}'`,
        param: 'id',
        code: 'resource_missing',
      },
    })
    return 404
  }

  sendJson(res, 200, rows[0]._raw_data)
  return 200
}

// ---------------------------------------------------------------------------
// Postgres queries — paginated reads from seeded tables
// ---------------------------------------------------------------------------

type PageResult = { data: Record<string, unknown>[]; hasMore: boolean; lastId?: string }

type V1PageQuery = {
  limit: number
  afterId?: string
  beforeId?: string
  createdGt?: number
  createdGte?: number
  createdLt?: number
  createdLte?: number
}

type V2PageQuery = {
  limit: number
  afterId?: string
}

async function resolveCursorCreated(
  pool: pg.Pool,
  schema: string,
  tableName: string,
  cursorId: string
): Promise<number | undefined> {
  const q = quoteIdentifier
  const result = await pool.query<{ created: string }>(
    `SELECT created FROM ${q(schema)}.${q(tableName)} WHERE id = $1`,
    [cursorId]
  )
  return result.rows.length > 0 ? Number(result.rows[0].created) : undefined
}

/**
 * V1: created DESC, id DESC; tuple cursors for starting_after / ending_before.
 */
async function queryPageV1(
  pool: pg.Pool,
  schema: string,
  tableName: string,
  opts: V1PageQuery
): Promise<PageResult> {
  const q = quoteIdentifier
  const conditions: string[] = []
  const values: unknown[] = []
  let idx = 0
  const useEndingBefore = !opts.afterId && !!opts.beforeId

  if (opts.afterId) {
    const cursorCreated = await resolveCursorCreated(pool, schema, tableName, opts.afterId)
    if (cursorCreated == null) return { data: [], hasMore: false }
    conditions.push(`(created, id) < ($${++idx}::bigint, $${++idx})`)
    values.push(cursorCreated, opts.afterId)
  }
  if (opts.beforeId) {
    const cursorCreated = await resolveCursorCreated(pool, schema, tableName, opts.beforeId)
    if (cursorCreated == null) return { data: [], hasMore: false }
    conditions.push(`(created, id) > ($${++idx}::bigint, $${++idx})`)
    values.push(cursorCreated, opts.beforeId)
  }
  if (opts.createdGt != null) {
    conditions.push(`created > $${++idx}`)
    values.push(opts.createdGt)
  }
  if (opts.createdGte != null) {
    conditions.push(`created >= $${++idx}`)
    values.push(opts.createdGte)
  }
  if (opts.createdLt != null) {
    conditions.push(`created < $${++idx}`)
    values.push(opts.createdLt)
  }
  if (opts.createdLte != null) {
    conditions.push(`created <= $${++idx}`)
    values.push(opts.createdLte)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const fetchLimit = opts.limit + 1
  values.push(fetchLimit)

  const orderDir = useEndingBefore ? 'ASC' : 'DESC'
  const orderClause = `ORDER BY created ${orderDir}, id ${orderDir}`

  const rows = await safeQuery(
    pool,
    `SELECT _raw_data FROM ${q(schema)}.${q(tableName)} ${where} ${orderClause} LIMIT $${++idx}`,
    values
  )

  const hasMore = rows.length > opts.limit
  const page = rows.slice(0, opts.limit)
  if (useEndingBefore) page.reverse()

  const data = page.map((r) => r._raw_data)
  const lastId = data.length > 0 ? (data[data.length - 1].id as string) : undefined
  return { data, hasMore, lastId }
}

/**
 * V2: opaque page tokens map to id ASC + `id > cursor` (no created ordering).
 */
async function queryPageV2(
  pool: pg.Pool,
  schema: string,
  tableName: string,
  opts: V2PageQuery
): Promise<PageResult> {
  const q = quoteIdentifier
  const conditions: string[] = []
  const values: unknown[] = []
  let idx = 0

  if (opts.afterId) {
    conditions.push(`id > $${++idx}`)
    values.push(opts.afterId)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const fetchLimit = opts.limit + 1
  values.push(fetchLimit)

  const rows = await safeQuery(
    pool,
    `SELECT _raw_data FROM ${q(schema)}.${q(tableName)} ${where} ORDER BY id ASC LIMIT $${++idx}`,
    values
  )

  const hasMore = rows.length > opts.limit
  const page = rows.slice(0, opts.limit)
  const data = page.map((r) => r._raw_data)
  const lastId = data.length > 0 ? (data[data.length - 1].id as string) : undefined
  return { data, hasMore, lastId }
}

async function safeQuery(
  pool: pg.Pool,
  sql: string,
  values: unknown[]
): Promise<{ _raw_data: Record<string, unknown> }[]> {
  try {
    const result = await pool.query(sql, values)
    return result.rows
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === '42P01') return []
    throw err
  }
}

function clampLimit(raw: string | null, defaultLimit: number): number {
  const n = parseInt(raw ?? '', 10)
  if (!Number.isFinite(n) || n < 1) return defaultLimit
  return Math.min(n, 100)
}

function parseIntParam(raw: string | null): number | undefined {
  if (raw == null) return undefined
  const n = parseInt(raw, 10)
  return Number.isFinite(n) ? n : undefined
}

function encodePageToken(id: string): string {
  return Buffer.from(id).toString('base64url')
}

function decodePageToken(token: string): string {
  return Buffer.from(token, 'base64url').toString()
}

/** Carry forward expand / expand[] (and similar) on v2 next_page_url. */
function buildV2NextPageUrl(
  apiPath: string,
  limit: number,
  pageToken: string,
  incoming: URLSearchParams
): string {
  const qs = new URLSearchParams()
  qs.set('limit', String(limit))
  qs.set('page', pageToken)
  for (const [key, value] of incoming.entries()) {
    if (key === 'limit' || key === 'page') continue
    if (key === 'expand' || key.startsWith('expand')) qs.append(key, value)
  }
  const suffix = qs.toString()
  return suffix ? `${apiPath}?${suffix}` : apiPath
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function logRequest(method: string, url: string, statusCode: number): void {
  process.stderr.write(`[sync-test-utils] ${method} ${url} → ${statusCode}\n`)
}

function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(payload))
}

function redactConnectionString(connectionString: string): string {
  try {
    const parsed = new URL(connectionString)
    if (parsed.password) parsed.password = '***'
    return parsed.toString()
  } catch {
    return connectionString
  }
}
