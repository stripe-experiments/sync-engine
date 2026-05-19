#!/usr/bin/env bun

// Reconcile Stripe object IDs (via Sigma) against Postgres destination IDs.
// 1. Discovers tables from Postgres and fetches every ID per table
// 2. Fetches IDs from Sigma per table (skipping deleted rows where supported)
// 3. Diffs the two sets per table and prints matches, pg_only, sigma_only
//
// Zero external dependencies — uses Node 24 built-in fetch and psql for Postgres.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const POLL_INTERVAL_MS = 3_000
const POLL_TIMEOUT_MS = 5 * 60 * 1_000
const SIGMA_CONCURRENCY = Number(process.env.SIGMA_CONCURRENCY) || 4
const SIGMA_POST_MAX_RETRIES = Number(process.env.SIGMA_POST_MAX_RETRIES) || 8
const SIGMA_POST_RETRY_DELAY_MS = Number(process.env.SIGMA_POST_RETRY_DELAY_MS) || 15_000

class UsageError extends Error {}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

type ReconcileArgs = {
  pipelineId?: string
  dataDir?: string
  stripeApiKey?: string
  dbUrl?: string
  schema?: string
  table?: string
  output?: string
  help?: boolean
}

function parseArgs(argv: string[]): ReconcileArgs {
  const args: ReconcileArgs = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = argv[i + 1]
    if (arg === '--pipeline-id') {
      args.pipelineId = next
      i += 1
    } else if (arg === '--data-dir') {
      args.dataDir = next
      i += 1
    } else if (arg === '--stripe-api-key') {
      args.stripeApiKey = next
      i += 1
    } else if (arg === '--db-url') {
      args.dbUrl = next
      i += 1
    } else if (arg === '--schema') {
      args.schema = next
      i += 1
    } else if (arg === '--table') {
      args.table = next
      i += 1
    } else if (arg === '--output') {
      args.output = next
      i += 1
    } else if (arg === '--help' || arg === '-h') {
      args.help = true
    } else if (arg.startsWith('-')) {
      throw new UsageError(`Unknown argument: ${arg}`)
    } else if (args.pipelineId) {
      throw new UsageError(`Unexpected extra positional argument: ${arg}`)
    } else {
      args.pipelineId = arg
    }
  }
  return args
}

function usage() {
  return [
    'Reconcile Stripe Sigma IDs vs Postgres destination IDs.',
    '',
    'Usage:',
    '  node scripts/reconcile-sigma-vs-postgres.js pipe_shop_prod_pg_docker',
    '',
    '  node scripts/reconcile-sigma-vs-postgres.js \\',
    '    --pipeline-id pipe_shop_prod_pg_docker \\',
    '    --data-dir ~/.stripe-sync',
    '',
    'Fallback mode:',
    '  node scripts/reconcile-sigma-vs-postgres.js \\',
    '    --stripe-api-key sk_live_... \\',
    '    --db-url postgresql://user:pass@host:5432/db',
    '',
    'Options:',
    '  pipeline_id         Optional positional pipeline id. Reads <DATA_DIR>/<id>.json.',
    '  --pipeline-id       Same as positional pipeline id.',
    '  --data-dir          Optional. Falls back to DATA_DIR or ~/.stripe-sync.',
    '  --stripe-api-key    Required. Falls back to STRIPE_API_KEY env var.',
    '  --db-url            Optional. Falls back to DATABASE_URL or POSTGRES_URL.',
    '  --schema            Optional. Falls back to destination.postgres.schema or public.',
    '  --table             Optional. Reconcile only one Postgres table.',
    '  --output            Optional. Report path (default: tmp/reconcile-<timestamp>.json).',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Postgres — discover tables + counts dynamically
// ---------------------------------------------------------------------------

function escapeSqlLiteral(value) {
  return value.replaceAll("'", "''")
}

function discoverPostgresTables(dbUrl, schema) {
  const sql = `
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = '${escapeSqlLiteral(schema)}' AND table_type = 'BASE TABLE'
    ORDER BY table_name;
  `
  const result = spawnSync('psql', [dbUrl, '--no-psqlrc', '--csv', '-c', sql], {
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 1024 * 1024 * 1024, // 1 GB — enough for millions of short IDs
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `psql exited with status ${result.status}`)
  }
  const rows = parseCsv(result.stdout)
  return rows
    .slice(1)
    .map((r) => r[0]?.trim())
    .filter(Boolean)
}

/**
 * Fetch the full set of IDs for a table from Postgres. Uses streaming so
 * very large tables (millions of rows) don't hit the spawnSync ENOBUFS limit.
 */
function fetchPostgresIds(dbUrl, schema, table) {
  const sql = `SELECT id FROM ${quoteIdent(schema)}.${quoteIdent(table)} WHERE id IS NOT NULL;`
  return new Promise((resolve, reject) => {
    const ids = new Set()
    const stderrChunks = []
    let buffer = ''
    const child = spawn('psql', [dbUrl, '--no-psqlrc', '--csv', '-t', '-c', sql], {
      env: process.env,
    })
    child.stdout.setEncoding('utf8')
    child.stderr.on('data', (d) => stderrChunks.push(d))
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let idx
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (line) ids.add(line)
      }
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (buffer.trim()) ids.add(buffer.trim())
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks.map((c) => Buffer.from(c)))
          .toString()
          .trim()
        reject(new Error(stderr || `psql exited with status ${code}`))
        return
      }
      resolve(ids)
    })
  })
}

function quoteIdent(name) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`Unsafe table name: ${name}`)
  }
  return `"${name}"`
}

// ---------------------------------------------------------------------------
// Stripe Sigma
// ---------------------------------------------------------------------------

async function stripePost(apiKey, endpoint, params) {
  const res = await fetch(`https://api.stripe.com${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params).toString(),
  })
  const body = await res.json()
  if (!res.ok) {
    const err = new Error(
      `Stripe POST ${endpoint} failed (${res.status}): ${JSON.stringify(body.error ?? body)}`
    )
    err.stripeError = body.error
    throw err
  }
  return body
}

async function stripeGet(apiKey, endpoint) {
  const res = await fetch(`https://api.stripe.com${endpoint}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  const body = await res.json()
  if (!res.ok) {
    throw new Error(
      `Stripe GET ${endpoint} failed (${res.status}): ${JSON.stringify(body.error ?? body)}`
    )
  }
  return body
}

async function stripeDownload(apiKey, url) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Stripe file download failed (${res.status}): ${text}`)
  }
  return res.text()
}

// Tolerance (in seconds) on each side of the object's `created` timestamp.
// Sigma can occasionally drift by a second vs the API.
const LIST_API_TIMESTAMP_WINDOW_S = 1
const LIST_API_PAGE_LIMIT = 100
const LIST_API_MAX_PAGES = 50
const LIST_API_RPS = Number(process.env.LIST_API_RPS) || 15
const LIST_API_CONCURRENCY = Number(process.env.LIST_API_CONCURRENCY) || 15

// Leaky-bucket rate limiter at LIST_API_RPS requests/second across all
// concurrent workers. Each acquire reserves the next slot; waiters sleep
// until their slot opens.
const listApiIntervalMs = 1000 / LIST_API_RPS
let listApiNextAt = 0
async function listApiAcquire(): Promise<void> {
  const now = Date.now()
  const at = Math.max(now, listApiNextAt)
  listApiNextAt = at + listApiIntervalMs
  if (at > now) await sleep(at - now)
}

/**
 * Parse Sigma's `created` (unix seconds as number/string, or "YYYY-MM-DD HH:MM:SS"
 * datetime strings in UTC) into unix seconds. Returns null when unparseable.
 */
function parseSigmaCreatedSeconds(raw: unknown): number | null {
  if (raw == null || raw === '') return null
  const n = Number(raw)
  if (Number.isFinite(n) && n > 946_684_800 && n < 4_102_444_800) return n
  const match = String(raw).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/)
  if (match) {
    const [, y, mo, d, h, mi, s] = match
    return Math.floor(
      Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)) / 1000
    )
  }
  const fallback = new Date(String(raw))
  if (!Number.isNaN(fallback.getTime())) return Math.floor(fallback.getTime() / 1000)
  return null
}

/**
 * Page through Stripe's list endpoint for `resource`, filtered to a tight
 * window around `ts`, and return true if `id` is present. Returns false when
 * the list endpoint doesn't surface the object (the sync engine wouldn't
 * have synced it either).
 */
async function stripeListContainsAtTimestamp(
  apiKey: string,
  resource: string,
  ts: number,
  id: string
): Promise<boolean> {
  const basePath = STRIPE_API_OBJECT_ENDPOINTS[resource] ?? `/v1/${resource}`
  const gte = Math.max(0, Math.floor(ts) - LIST_API_TIMESTAMP_WINDOW_S)
  const lte = Math.ceil(ts) + LIST_API_TIMESTAMP_WINDOW_S
  let startingAfter: string | undefined
  for (let page = 0; page < LIST_API_MAX_PAGES; page += 1) {
    const params = new URLSearchParams()
    params.set('limit', String(LIST_API_PAGE_LIMIT))
    params.set('created[gte]', String(gte))
    params.set('created[lte]', String(lte))
    if (startingAfter) params.set('starting_after', startingAfter)
    await listApiAcquire()
    const body = await stripeGet(apiKey, `${basePath}?${params.toString()}`)
    const data = Array.isArray(body?.data) ? body.data : []
    for (const obj of data) {
      if (obj?.id === id) return true
    }
    if (!body?.has_more || data.length === 0) return false
    startingAfter = data[data.length - 1]?.id
    if (!startingAfter) return false
  }
  return false
}

/**
 * Fallback list check using `ids[]=id`. Used when no usable `created`
 * timestamp is available for the missing object. Still a list call (not
 * retrieve), so it respects the same scope the sync engine sees.
 */
async function stripeListContainsById(
  apiKey: string,
  resource: string,
  id: string
): Promise<boolean> {
  const basePath = STRIPE_API_OBJECT_ENDPOINTS[resource] ?? `/v1/${resource}`
  const params = new URLSearchParams()
  params.set('limit', String(LIST_API_PAGE_LIMIT))
  params.append('ids[]', id)
  await listApiAcquire()
  const body = await stripeGet(apiKey, `${basePath}?${params.toString()}`)
  const data = Array.isArray(body?.data) ? body.data : []
  return data.some((obj) => obj?.id === id)
}

/**
 * For each diff row, drop missing IDs that the list endpoint doesn't return
 * within a tight window of the Sigma `created` timestamp. The sync engine
 * only ingests list-endpoint results, so anything the list API hides is out
 * of scope and shouldn't be counted as missing.
 */
type ComparisonRow = {
  resource: string
  status: string
  missingRows: Array<{ id: string; created: unknown }>
  postgresMissing: number | null
}

async function filterMissingNotInListApi(
  apiKey: string,
  rows: ComparisonRow[]
): Promise<Array<{ resource: string; id: string; created: unknown; reason: string }>> {
  const removed: Array<{ resource: string; id: string; created: unknown; reason: string }> = []

  type WorkItem = { row: ComparisonRow; item: { id: string; created: unknown } }
  const queue: WorkItem[] = []
  const eligibleRows = new Set<ComparisonRow>()
  for (const row of rows) {
    if (row.status !== 'diff') continue
    if (!row.missingRows || row.missingRows.length === 0) continue
    if (!(row.resource in STRIPE_API_OBJECT_ENDPOINTS)) continue
    eligibleRows.add(row)
    for (const item of row.missingRows) queue.push({ row, item })
  }
  if (queue.length === 0) return removed

  console.error(
    `Verifying ${queue.length} missing IDs via list endpoint ` +
      `(rps=${LIST_API_RPS}, concurrency=${LIST_API_CONCURRENCY})...`
  )

  const keptIds = new Map<ComparisonRow, Set<string>>()
  for (const row of eligibleRows) keptIds.set(row, new Set())
  let done = 0
  const total = queue.length

  async function processOne({ row, item }: WorkItem) {
    const ts = parseSigmaCreatedSeconds(item.created)
    try {
      const found =
        ts != null
          ? await stripeListContainsAtTimestamp(apiKey, row.resource, ts, item.id)
          : await stripeListContainsById(apiKey, row.resource, item.id)
      if (found) {
        keptIds.get(row)!.add(item.id)
      } else {
        removed.push({
          resource: row.resource,
          id: item.id,
          created: item.created,
          reason: ts != null ? 'not_returned_by_list_api' : 'not_returned_by_list_api_ids',
        })
        process.stderr.write(
          `\n  list-api filter: ${row.resource} ${item.id} ` +
            `(created=${formatCreated(item.created)}) not returned by list endpoint — dropping from missing`
        )
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      process.stderr.write(
        `\n  list-api filter: ${row.resource} ${item.id} list check failed (${message}); keeping as missing`
      )
      keptIds.get(row)!.add(item.id)
    } finally {
      done += 1
      process.stderr.write(`\r  list-api filter: progress ${done}/${total}`)
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(LIST_API_CONCURRENCY, queue.length) }, async () => {
      while (queue.length > 0) {
        const work = queue.shift()
        if (!work) break
        await processOne(work)
      }
    })
  )
  process.stderr.write('\n')

  for (const row of eligibleRows) {
    const kept = keptIds.get(row)!
    row.missingRows = row.missingRows.filter((m) => kept.has(m.id))
    row.postgresMissing = row.missingRows.length
    row.status = row.missingRows.length === 0 ? 'match' : 'diff'
  }

  return removed
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function inferLivemodeFromApiKey(apiKey: string) {
  return !apiKey.toLowerCase().includes('test')
}

function isSigmaConcurrencyLimitError(err) {
  const msg = err?.stripeError?.message ?? err?.message ?? ''
  return /too many concurrently running Sigma queries/i.test(msg)
}

/** Tables whose list endpoint filters to `active = true` by default.
 *  Sigma retains inactive/archived objects that the list API doesn't surface,
 *  so we filter to active-only when querying Sigma for these tables. */
const SIGMA_TABLES_ACTIVE_ONLY = new Set(['prices', 'tax_rates'])

const SIGMA_TABLES_WITH_LIVEMODE = new Set(['issuing_personalization_designs', 'terminal_readers'])

const SIGMA_TABLES_WITHOUT_LIVEMODE = new Set([
  'application_fees',
  'billing_credit_grants',
  'charges',
  'checkout_sessions',
  'connected_accounts',
  'connected_account_treasury_financial_accounts',
  'coupons',
  'credit_notes',
  'customers',
  'disputes',
  'early_fraud_warnings',
  'invoice_items',
  'invoice_payments',
  'invoices',
  'issuing_authorizations',
  'issuing_cardholders',
  'issuing_cards',
  'issuing_disputes',
  'issuing_transactions',
  'payment_intents',
  'payment_links',
  'plans',
  'prices',
  'products',
  'promotion_codes',
  'quotes',
  'refunds',
  'setup_intents',
  'subscription_schedules',
  'subscriptions',
  'tax_rates',
  'topups',
  'transfers',
])

function sigmaLivemodeForTable(table: string, livemode: boolean): boolean | null {
  if (SIGMA_TABLES_WITH_LIVEMODE.has(table)) return livemode
  if (SIGMA_TABLES_WITHOUT_LIVEMODE.has(table)) return null
  return null
}

type SigmaIdsQueryVariant = {
  createdColumn: string | undefined
  hasDeletedCol: boolean
  activeOnly: boolean
  livemode: boolean | null
  extraConditions: string[]
}

/**
 * Build a Sigma query that returns (id[, created]) rows for the given table.
 * Tables in `tablesWithDeletedCol` get a WHERE clause that excludes deleted
 * rows so results match what Stripe's `list` endpoints return.
 * Tables in SIGMA_TABLES_ACTIVE_ONLY get an additional `active = true` filter.
 */
function buildSigmaIdsSql(
  table: string,
  { createdColumn, hasDeletedCol, activeOnly, livemode, extraConditions }: SigmaIdsQueryVariant
) {
  const conditions = []
  if (hasDeletedCol) conditions.push('NOT COALESCE(deleted, false)')
  if (activeOnly) conditions.push('active = true')
  if (livemode != null) conditions.push(`livemode = ${livemode ? 'true' : 'false'}`)
  conditions.push(...extraConditions)
  const where = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : ''
  const cols = createdColumn ? `id, ${createdColumn} AS created` : 'id'
  return `SELECT ${cols} FROM "${table}"${where}`
}

function parseMissingTables(errorMessage) {
  const match = errorMessage.match(/tables which do not exist or are inaccessible:\s*\[([^\]]+)\]/i)
  if (!match) return null
  return match[1].split(',').map((t) => t.trim())
}

class SigmaQueryFailedError extends Error {
  constructor(queryRunId, response) {
    const errMsg = response.error?.message ?? JSON.stringify(response.error ?? null)
    super(`Sigma query failed (status=${response.status}) id=${queryRunId} error=${errMsg}`)
    this.queryRunId = queryRunId
    this.response = response
    this.errorMessage = response.error?.message
  }
}

async function pollSigmaRun(apiKey, queryRunId) {
  const start = Date.now()
  let current = await stripeGet(apiKey, `/v1/sigma/query_runs/${queryRunId}`)

  while (current.status === 'running') {
    if (Date.now() - start > POLL_TIMEOUT_MS) {
      throw new Error(`Sigma query timed out after ${POLL_TIMEOUT_MS / 1000}s: ${queryRunId}`)
    }
    await sleep(POLL_INTERVAL_MS)
    current = await stripeGet(apiKey, `/v1/sigma/query_runs/${queryRunId}`)
  }

  // Stripe's Sigma API uses "completed" in some versions and "succeeded" in others.
  if (current.status !== 'completed' && current.status !== 'succeeded') {
    throw new SigmaQueryFailedError(queryRunId, current)
  }
  return current
}

async function downloadSigmaResult(apiKey, completed) {
  const fileUrl = completed.file?.url
  const fileId = completed.file?.id ?? completed.result?.file
  if (!fileUrl && !fileId) {
    throw new Error(`Sigma query succeeded but no file found (id=${completed.id})`)
  }
  const downloadUrl = fileUrl ?? `https://files.stripe.com/v1/files/${fileId}/contents`
  return stripeDownload(apiKey, downloadUrl)
}

async function runIdsQuery(apiKey, sql, table) {
  let queryRun
  for (let attempt = 0; ; attempt += 1) {
    try {
      queryRun = await stripePost(apiKey, '/v1/sigma/query_runs', { sql })
      break
    } catch (err) {
      if (!isSigmaConcurrencyLimitError(err) || attempt >= SIGMA_POST_MAX_RETRIES) throw err
      const waitMs = SIGMA_POST_RETRY_DELAY_MS * (attempt + 1)
      console.error(
        `  Sigma concurrency limit for ${table}; retrying POST in ${Math.round(waitMs / 1000)}s ` +
          `(attempt ${attempt + 1}/${SIGMA_POST_MAX_RETRIES})`
      )
      await sleep(waitMs)
    }
  }
  const completed = await pollSigmaRun(apiKey, queryRun.id)
  const csv = await downloadSigmaResult(apiKey, completed)
  const rows = parseCsv(csv)
  if (rows.length < 2) return { ids: new Set(), createdById: new Map() }
  const header = rows[0]
  const idIdx = header.indexOf('id')
  if (idIdx === -1) throw new Error(`Sigma result for ${table} missing "id" column`)
  const createdIdx = header.indexOf('created')
  const ids = new Set()
  const createdById = new Map()
  for (const r of rows.slice(1)) {
    const id = r[idIdx]?.trim()
    if (!id) continue
    ids.add(id)
    if (createdIdx !== -1) {
      const created = r[createdIdx]?.trim()
      if (created) createdById.set(id, created)
    }
  }
  return { ids, createdById }
}

async function runSigmaRowsQuery(apiKey, sql, table) {
  let queryRun
  for (let attempt = 0; ; attempt += 1) {
    try {
      queryRun = await stripePost(apiKey, '/v1/sigma/query_runs', { sql })
      break
    } catch (err) {
      if (!isSigmaConcurrencyLimitError(err) || attempt >= SIGMA_POST_MAX_RETRIES) throw err
      const waitMs = SIGMA_POST_RETRY_DELAY_MS * (attempt + 1)
      console.error(
        `  Sigma concurrency limit for ${table}; retrying detail POST in ${Math.round(waitMs / 1000)}s ` +
          `(attempt ${attempt + 1}/${SIGMA_POST_MAX_RETRIES})`
      )
      await sleep(waitMs)
    }
  }

  const completed = await pollSigmaRun(apiKey, queryRun.id)
  const csv = await downloadSigmaResult(apiKey, completed)
  const rows = parseCsv(csv)
  if (rows.length < 2) return []

  const header = rows[0]
  return rows
    .slice(1)
    .map((row) => Object.fromEntries(header.map((name, idx) => [name, row[idx] ?? null])))
}

function isMissingColumnError(err) {
  const msg = err.errorMessage ?? err.message ?? ''
  return /column|invalid identifier/i.test(msg)
}

function isRetryableSigmaQueryError(err) {
  return isMissingColumnError(err) || err instanceof SigmaQueryFailedError
}

/**
 * Fetch IDs (with `created` where available) for a Sigma table. Retries
 * progressively stripping columns/filters when Sigma reports they don't
 * exist on that particular table.
 */
async function fetchSigmaIds(
  apiKey: string,
  table: string,
  hasDeletedCol: boolean,
  activeOnly = false,
  livemode: boolean | null = null
) {
  const createdColumns = SIGMA_CREATED_COLUMNS[table] ?? ['created', undefined]
  const extraConditions = SIGMA_TABLE_CONDITIONS[table] ?? []

  function buildVariants(mode: boolean | null): SigmaIdsQueryVariant[] {
    const next = [
      ...createdColumns.map((createdColumn) => ({
        createdColumn,
        hasDeletedCol,
        activeOnly,
        livemode: mode,
        extraConditions,
      })),
    ]
    if (hasDeletedCol) {
      next.push(
        ...createdColumns.map((createdColumn) => ({
          createdColumn,
          hasDeletedCol: false,
          activeOnly,
          livemode: mode,
          extraConditions,
        }))
      )
    }
    if (activeOnly) {
      // Try without active in case older Sigma schemas omit the column.
      next.push(
        ...createdColumns.map((createdColumn) => ({
          createdColumn,
          hasDeletedCol: false,
          activeOnly: false,
          livemode: mode,
          extraConditions,
        }))
      )
    }
    if (extraConditions.length > 0) {
      next.push(
        ...createdColumns.map((createdColumn) => ({
          createdColumn,
          hasDeletedCol: false,
          activeOnly: false,
          livemode: mode,
          extraConditions: [],
        }))
      )
    }
    return next
  }

  const variants = buildVariants(livemode)

  let lastErr
  for (const [index, variant] of variants.entries()) {
    const sql = buildSigmaIdsSql(table, variant)
    try {
      return await runIdsQuery(apiKey, sql, table)
    } catch (err) {
      lastErr = err
      if (!isRetryableSigmaQueryError(err)) throw err
      if (index < variants.length - 1) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`  retrying Sigma query for ${table} after error: ${message}; sql=${sql}`)
      }
    }
  }
  throw lastErr
}

/** Try to detect a missing-table error from either POST or poll response. */
function detectMissingTables(err) {
  const msg = err.stripeError?.message ?? err.errorMessage ?? err.message
  return parseMissingTables(msg)
}

/** Stripe Sigma tables that expose a `deleted` column. Stripe Sigma doesn't
 *  let us query `information_schema`, so we maintain this list by hand based on
 *  Stripe's public data dictionary. Add entries as needed. */
const SIGMA_TABLES_WITH_DELETED = new Set([
  'bank_accounts',
  'cards',
  'customers',
  'discounts',
  'skus',
  'subscription_items',
  'tax_ids',
])

const SIGMA_CREATED_COLUMNS: Record<string, Array<string | undefined>> = {
  invoice_items: ['date', undefined],
}

const SIGMA_TABLE_CONDITIONS: Record<string, string[]> = {
  subscriptions: ["status != 'canceled'"],
}

const STRIPE_API_OBJECT_ENDPOINTS = {
  application_fees: '/v1/application_fees',
  billing_credit_grants: '/v1/billing/credit_grants',
  billing_meters: '/v1/billing/meters',
  charges: '/v1/charges',
  checkout_sessions: '/v1/checkout/sessions',
  coupons: '/v1/coupons',
  credit_notes: '/v1/credit_notes',
  customers: '/v1/customers',
  disputes: '/v1/disputes',
  early_fraud_warnings: '/v1/radar/early_fraud_warnings',
  invoice_payments: '/v1/invoice_payments',
  invoiceitems: '/v1/invoiceitems',
  invoices: '/v1/invoices',
  issuing_authorizations: '/v1/issuing/authorizations',
  issuing_cardholders: '/v1/issuing/cardholders',
  issuing_cards: '/v1/issuing/cards',
  issuing_disputes: '/v1/issuing/disputes',
  issuing_personalization_designs: '/v1/issuing/personalization_designs',
  issuing_transactions: '/v1/issuing/transactions',
  payment_intents: '/v1/payment_intents',
  payment_links: '/v1/payment_links',
  plans: '/v1/plans',
  prices: '/v1/prices',
  products: '/v1/products',
  promotion_codes: '/v1/promotion_codes',
  quotes: '/v1/quotes',
  refunds: '/v1/refunds',
  setup_intents: '/v1/setup_intents',
  subscription_schedules: '/v1/subscription_schedules',
  subscriptions: '/v1/subscriptions',
  tax_rates: '/v1/tax_rates',
  terminal_readers: '/v1/terminal/readers',
  topups: '/v1/topups',
  transfers: '/v1/transfers',
  treasury_financial_accounts: '/v1/treasury/financial_accounts',
}

/** Known Postgres → Sigma name aliases. Add entries as you discover more. */
const SIGMA_ALIAS: Record<string, string> = {
  accounts: 'connected_accounts',
  invoiceitems: 'invoice_items',
  // NOTE: do NOT alias tax_ids → customer_tax_ids. The sync engine uses
  // /v1/tax_ids which returns account-level tax IDs, while Sigma's
  // customer_tax_ids table contains customer-scoped tax IDs (different dataset).
  billing_alerts: 'billing_meter_alerts',
  treasury_financial_accounts: 'connected_account_treasury_financial_accounts',
}

/** Tables to skip from reconciliation entirely. These cannot be meaningfully
 *  compared because the sync engine either excludes them or the top-level API
 *  endpoint doesn't return the same scope of data as Sigma. */
const RECONCILE_SKIP = new Set([
  'billing_alerts',
  'billing_portal_configurations',
  // Requires `customer` query param; explicitly excluded from sync engine.
  'billing_credit_balance_transactions',
  'climate_orders',
  'climate_products',
  'files',
  'financial_connections_accounts',
  'identity_verification_sessions',
  // Sigma includes historical/internal designs that List/Retrieve do not expose.
  'issuing_personalization_designs',
  // Top-level /v1/payment_methods only returns unattached/Treasury payment methods.
  // Sigma includes customer-attached pm_, src_, and card_ objects.
  'payment_methods',
  'payouts',
  'reporting_report_runs',
  'reporting_report_types',
  'reviews',
  'scheduled_query_runs',
  'tax_ids',
  'test_helpers_test_clocks',
  'v2_core_accounts',
  'v2_core_event_destinations',
])

/** Per-table ID filters applied to Sigma results before comparison.
 *  Sigma tables sometimes include object types that the sync engine fetches
 *  via a different endpoint or that aren't available with the current API key mode. */
const SIGMA_ID_FILTERS: Record<string, (id: string, livemode: boolean) => boolean> = {
  // Sigma's "transfers" table includes payouts (po_ prefix). The sync engine
  // fetches payouts via /v1/payouts, not /v1/transfers.
  transfers: (id) => !id.startsWith('po_'),
  // Sigma includes test-mode billing meters (mtr_test_ prefix) which a
  // live-mode API key does not return from /v1/billing/meters.
  billing_meters: (id, livemode) => !livemode || !id.startsWith('mtr_test_'),
}

/**
 * Run one Sigma query per table, with bounded concurrency. Isolates failures
 * (missing table, opaque query error) to the offending table only so one
 * bad table doesn't tank the whole reconcile.
 */
async function runSigmaForResources(apiKey: string, resources: string[], livemode: boolean) {
  const skipped: string[] = []
  const dataByTable = new Map() // pgTable → { ids: Set<id>, createdById: Map<id, created> }
  let done = 0

  // Sigma doesn't expose information_schema, so we can't discover its tables
  // dynamically. We try each PG table name in Sigma (with known aliases) and
  // rely on Sigma's error message to tell us which are unavailable.
  const work = resources.map((pgTable) => ({
    pgTable,
    sigmaTable: SIGMA_ALIAS[pgTable] ?? pgTable,
  }))

  const aliased = work.filter((w) => w.sigmaTable !== w.pgTable)
  if (aliased.length > 0) {
    console.error(`  aliased: ${aliased.map((w) => `${w.pgTable}→${w.sigmaTable}`).join(', ')}`)
  }

  const queryable = work
  type SigmaResourceWork = { pgTable: string; sigmaTable: string }
  const unexpectedErrors: string[] = []

  async function runOne({ pgTable, sigmaTable }: SigmaResourceWork) {
    try {
      const data = await fetchSigmaIds(
        apiKey,
        sigmaTable,
        SIGMA_TABLES_WITH_DELETED.has(sigmaTable),
        SIGMA_TABLES_ACTIVE_ONLY.has(pgTable),
        sigmaLivemodeForTable(sigmaTable, livemode)
      )
      dataByTable.set(pgTable, data)
    } catch (err) {
      const missing = detectMissingTables(err)
      if (!missing || !missing.includes(sigmaTable)) {
        const message = err instanceof Error ? err.message : String(err)
        unexpectedErrors.push(`${pgTable}: ${message}`)
      }
      skipped.push(pgTable)
    } finally {
      done += 1
      process.stderr.write(`\r  progress: ${done}/${queryable.length}`)
    }
  }

  const queue = [...queryable]
  console.error(
    `Fetching IDs from ${queue.length} Sigma tables (concurrency=${SIGMA_CONCURRENCY})...`
  )
  await Promise.all(
    Array.from({ length: Math.min(SIGMA_CONCURRENCY, queue.length) }, async () => {
      while (queue.length > 0) {
        const item = queue.shift()
        if (!item) break
        await runOne(item)
      }
    })
  )
  process.stderr.write('\n')

  if (unexpectedErrors.length > 0) {
    console.error(`  ${unexpectedErrors.length} unexpected error(s):`)
    for (const e of unexpectedErrors) console.error(`    ${e}`)
  }

  return { dataByTable, skipped }
}

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"') {
      inQuotes = true
      continue
    }
    if (ch === ',') {
      row.push(field)
      field = ''
      continue
    }
    if (ch === '\n') {
      row.push(field)
      if (row.some((v) => v.length > 0)) rows.push(row)
      row = []
      field = ''
      continue
    }
    if (ch === '\r') continue
    field += ch
  }
  row.push(field)
  if (row.some((v) => v.length > 0)) rows.push(row)
  return rows
}

// ---------------------------------------------------------------------------
// Comparison + output
// ---------------------------------------------------------------------------

// We only care about IDs that exist in Sigma but are missing from Postgres.
// Rows present in Postgres but absent from Sigma are disregarded.
function diffSets(sigmaData, pgIds) {
  const common = new Set()
  const postgresMissing = []
  for (const id of sigmaData.ids) {
    if (pgIds.has(id)) {
      common.add(id)
    } else {
      postgresMissing.push({
        id,
        created: sigmaData.createdById.get(id) ?? null,
      })
    }
  }
  postgresMissing.sort((a, b) => {
    const ac = Number(a.created)
    const bc = Number(b.created)
    const aValid = Number.isFinite(ac)
    const bValid = Number.isFinite(bc)
    if (aValid && bValid) return bc - ac
    if (aValid) return -1
    if (bValid) return 1
    return 0
  })
  return { common, postgresMissing }
}

function formatCreated(raw) {
  if (!raw) return 'unknown'
  const n = Number(raw)
  // Sigma stores `created` as unix seconds for most resources. Sanity-check
  // the range so we don't mis-render a numeric column that isn't a timestamp.
  if (Number.isFinite(n) && n > 946_684_800 && n < 4_102_444_800) {
    return new Date(n * 1000).toISOString()
  }
  const d = new Date(raw)
  if (!Number.isNaN(d.getTime())) return d.toISOString()
  return String(raw)
}

function buildComparisonRows(sigmaDataByTable, postgresIdsByTable, skippedTables) {
  const skippedSet = new Set(skippedTables)
  const resources = new Set([...sigmaDataByTable.keys(), ...postgresIdsByTable.keys()])

  return [...resources]
    .sort((a, b) => a.localeCompare(b))
    .map((resource) => {
      const sigmaData = sigmaDataByTable.get(resource)
      const pgIds = postgresIdsByTable.get(resource) ?? new Set()

      if (skippedSet.has(resource) || sigmaData === undefined) {
        return {
          resource,
          sigmaCount: null,
          postgresCount: pgIds.size,
          matches: null,
          postgresMissing: null,
          missingRows: [],
          status: 'skipped_in_sigma',
        }
      }

      const { common, postgresMissing } = diffSets(sigmaData, pgIds)
      const status = postgresMissing.length === 0 ? 'match' : 'diff'

      return {
        resource,
        sigmaCount: sigmaData.ids.size,
        postgresCount: pgIds.size,
        matches: common.size,
        postgresMissing: postgresMissing.length,
        missingRows: postgresMissing,
        status,
      }
    })
}

function formatTable(rows) {
  const headers = ['resource', 'sigma', 'postgres', 'matches', 'postgres_missing', 'status']
  const stringRows = rows.map((r) => [
    r.resource,
    r.sigmaCount?.toString() ?? '-',
    r.postgresCount?.toString() ?? '-',
    r.matches?.toString() ?? '-',
    r.postgresMissing?.toString() ?? '-',
    r.status,
  ])
  const widths = headers.map((h, i) => Math.max(h.length, ...stringRows.map((r) => r[i].length)))
  const separator = widths.map((w) => '-'.repeat(w)).join('-+-')
  const fmt = (cells) =>
    cells
      .map((c, i) => {
        const right = i > 0 && i < headers.length - 1
        return right ? c.padStart(widths[i]) : c.padEnd(widths[i])
      })
      .join(' | ')
  return [fmt(headers), separator, ...stringRows.map(fmt)].join('\n')
}

function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2)
  } catch (err) {
    return JSON.stringify({ error: `Could not serialize value: ${errorMessage(err)}` }, null, 2)
  }
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err)
}

function indentBlock(text, prefix) {
  return text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n')
}

function formatSkippedTables(rows) {
  if (rows.length === 0) return ''

  const lines = ['=== Skipped tables (no Sigma/source data) ===']
  for (const row of rows) {
    lines.push(`  - ${row.resource} (postgres=${row.postgresCount})`)
  }
  return lines.join('\n')
}

async function fetchMissingSampleDetails(apiKey, rows, limit = 3) {
  const details = []
  const diffRows = rows.filter((r) => r.status === 'diff' && r.missingRows.length > 0)

  for (const row of diffRows) {
    const sigmaTable = SIGMA_ALIAS[row.resource] ?? row.resource
    for (const item of row.missingRows.slice(0, limit)) {
      const detail: {
        resource: string
        sigma_table: string
        id: string
        created: unknown
        sigma: unknown
      } = {
        resource: row.resource,
        sigma_table: sigmaTable,
        id: item.id,
        created: item.created,
        sigma: null,
      }

      try {
        const sql = `SELECT * FROM "${sigmaTable}" WHERE id = '${escapeSqlLiteral(item.id)}' LIMIT 1`
        const rows = await runSigmaRowsQuery(apiKey, sql, sigmaTable)
        detail.sigma = { ok: true, row: rows[0] ?? null }
      } catch (err) {
        detail.sigma = { ok: false, error: errorMessage(err) }
      }

      details.push(detail)
    }
  }

  return details
}

function formatMissingSamples(details) {
  if (details.length === 0) return ''

  const lines = ['=== Missing samples (source only, first 3 per resource) ===']
  let currentResource = null
  for (const item of details) {
    if (item.resource !== currentResource) {
      currentResource = item.resource
      lines.push(`${item.resource}:`)
    }
    lines.push(`  - id=${item.id} created=${formatCreated(item.created)}`)
    lines.push('    sigma:')
    lines.push(indentBlock(safeJson(item.sigma), '      '))
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const DEFAULT_DATA_DIR = process.env.DATA_DIR ?? join(homedir(), '.stripe-sync')

function readPipeline(dataDir, pipelineId) {
  const filePath = join(dataDir, `${pipelineId}.json`)
  if (!existsSync(filePath)) {
    throw new UsageError(`Pipeline ${pipelineId} not found in ${dataDir}`)
  }
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

function resolveInputs(args) {
  const dataDir = args.dataDir ?? DEFAULT_DATA_DIR

  if (args.pipelineId) {
    const pipeline = readPipeline(dataDir, args.pipelineId)
    if (pipeline.source?.type !== 'stripe') {
      throw new UsageError(`Pipeline ${args.pipelineId} source must be stripe`)
    }
    if (pipeline.destination?.type !== 'postgres') {
      throw new UsageError(`Pipeline ${args.pipelineId} destination must be postgres`)
    }

    const stripe = pipeline.source.stripe ?? {}
    const postgres = pipeline.destination.postgres ?? {}
    const pipelineApiKey = stripe.api_key
    const pipelineDbUrl = postgres.url ?? postgres.connection_string
    const pipelineSchema = postgres.schema ?? 'public'

    return {
      dataDir,
      pipelineId: args.pipelineId,
      apiKey: pipelineApiKey,
      dbUrl: pipelineDbUrl,
      schema: pipelineSchema,
    }
  }

  return {
    dataDir,
    pipelineId: undefined,
    apiKey: args.stripeApiKey ?? process.env.STRIPE_API_KEY,
    dbUrl: args.dbUrl ?? process.env.DATABASE_URL ?? process.env.POSTGRES_URL,
    schema: args.schema ?? 'public',
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(usage())
    return
  }

  const { apiKey, dbUrl, schema, pipelineId } = resolveInputs(args)
  if (!apiKey) throw new UsageError('Provide --stripe-api-key or set STRIPE_API_KEY')

  if (!dbUrl) throw new UsageError('Provide --db-url or set DATABASE_URL / POSTGRES_URL')

  const livemode = inferLivemodeFromApiKey(apiKey)
  console.error(`Sigma livemode filter: livemode = ${livemode ? 'true' : 'false'}`)

  // Step 1: discover tables from Postgres
  console.error(`Discovering tables from Postgres schema ${schema}...`)
  let pgTables = discoverPostgresTables(dbUrl, schema)
  if (args.table) {
    if (!pgTables.includes(args.table)) {
      throw new UsageError(`Table ${args.table} not found in Postgres schema ${schema}`)
    }
    pgTables = [args.table]
  }
  console.error(`  found ${pgTables.length} tables in ${schema}`)

  // Step 2: fetch IDs for every PG table (serial to avoid overloading psql)
  console.error(`Fetching IDs from Postgres (${pgTables.length} tables)...`)
  const postgresIdsByTable = new Map()
  let pgDone = 0
  for (const table of pgTables) {
    try {
      const ids = await fetchPostgresIds(dbUrl, schema, table)
      postgresIdsByTable.set(table, ids)
    } catch (err) {
      console.error(`\n  failed to fetch IDs from ${table}: ${err.message}`)
      postgresIdsByTable.set(table, new Set())
    } finally {
      pgDone += 1
      process.stderr.write(`\r  progress: ${pgDone}/${pgTables.length}`)
    }
  }
  process.stderr.write('\n')

  // Filter out tables that can't be meaningfully reconciled
  const excludedTables = pgTables.filter((t) => RECONCILE_SKIP.has(t))
  const pgTablesToCompare = pgTables.filter((t) => !RECONCILE_SKIP.has(t))
  if (excludedTables.length > 0) {
    console.error(`  excluded from comparison: ${excludedTables.join(', ')}`)
  }

  // Step 3: fetch IDs from Sigma for comparable tables
  const { dataByTable: sigmaDataByTable, skipped } = await runSigmaForResources(
    apiKey,
    pgTablesToCompare,
    livemode
  )

  // Apply per-table ID filters to remove object types that the sync engine
  // fetches via a different endpoint or can't access with the current key mode.
  for (const [table, filterFn] of Object.entries(SIGMA_ID_FILTERS)) {
    const data = sigmaDataByTable.get(table)
    if (!data) continue
    const filteredIds = new Set()
    const filteredCreatedById = new Map()
    for (const id of data.ids) {
      if (filterFn(id, livemode)) {
        filteredIds.add(id)
        const created = data.createdById.get(id)
        if (created) filteredCreatedById.set(id, created)
      }
    }
    const removed = data.ids.size - filteredIds.size
    if (removed > 0) {
      console.error(`  filtered ${removed} IDs from ${table} (Sigma scope mismatch)`)
    }
    sigmaDataByTable.set(table, { ids: filteredIds, createdById: filteredCreatedById })
  }

  // Step 4: compare + print
  const rows = buildComparisonRows(sigmaDataByTable, postgresIdsByTable, [
    ...skipped,
    ...excludedTables,
  ])

  // Drop missing IDs that the Stripe list endpoint doesn't return at their
  // creation timestamp — those objects are out of scope for the sync engine.
  const droppedByListApi = await filterMissingNotInListApi(apiKey, rows)
  if (droppedByListApi.length > 0) {
    console.error(
      `  list-api filter: dropped ${droppedByListApi.length} missing ID(s) not returned by list endpoint`
    )
  }

  const matchCount = rows.filter((r) => r.status === 'match').length
  const diffCount = rows.filter((r) => r.status === 'diff').length
  const skippedCount = rows.filter((r) => r.status === 'skipped_in_sigma').length
  const skippedRows = rows.filter((r) => r.status === 'skipped_in_sigma')
  const diffRows = rows.filter((r) => r.status === 'diff')
  const missingSampleDetails =
    diffRows.length > 0 ? await fetchMissingSampleDetails(apiKey, diffRows) : []

  // Write detailed report to file (defaults to tmp/reconcile-<timestamp>.json)
  const outputPath =
    args.output ??
    `tmp/reconcile-${pipelineId ?? 'manual'}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  {
    mkdirSync(dirname(outputPath), { recursive: true })
    const report = {
      timestamp: new Date().toISOString(),
      pipeline_id: pipelineId ?? null,
      schema,
      livemode,
      summary: {
        tables: pgTables.length,
        compared: matchCount + diffCount,
        matches: matchCount,
        differences: diffCount,
        skipped: skippedCount,
      },
      formatted: formatTable(rows.filter((r) => r.status !== 'skipped_in_sigma')),
      skipped_tables: skippedRows,
      missing_samples: missingSampleDetails,
      dropped_by_list_api: droppedByListApi,
      tables: rows,
    }
    writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n')
    console.log(`Report: ${outputPath}`)
  }

  // Console summary
  console.log('')
  console.log(
    [
      `tables in postgres: ${pgTables.length}`,
      `compared:           ${matchCount + diffCount}`,
      `matches:            ${matchCount}`,
      `differences:        ${diffCount}`,
      `skipped (no sigma): ${skippedCount}`,
    ].join('\n')
  )

  console.log('')
  console.log(formatTable(rows.filter((r) => r.status !== 'skipped_in_sigma')))
  const skippedTableOutput = formatSkippedTables(skippedRows)
  if (skippedTableOutput) {
    console.log('')
    console.log(skippedTableOutput)
  }
  const missingSamples = formatMissingSamples(missingSampleDetails)
  if (missingSamples) {
    console.log('')
    console.log(missingSamples)
  }

  if (diffCount > 0) process.exit(1)
}

try {
  await main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(message)
  if (error instanceof UsageError) {
    console.error('')
    console.error(usage())
  }
  process.exit(1)
}
