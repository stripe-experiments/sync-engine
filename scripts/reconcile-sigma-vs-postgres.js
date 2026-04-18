#!/usr/bin/env node

// Reconcile Stripe object IDs (via Sigma) against Postgres destination IDs.
// 1. Discovers tables from Postgres and fetches every ID per table
// 2. Fetches IDs from Sigma per table (skipping deleted rows where supported)
// 3. Diffs the two sets per table and prints matches, pg_only, sigma_only
//
// Zero external dependencies — uses Node 24 built-in fetch and psql for Postgres.

import { spawn, spawnSync } from 'node:child_process'

const POLL_INTERVAL_MS = 3_000
const POLL_TIMEOUT_MS = 5 * 60 * 1_000
const SIGMA_CONCURRENCY = 16

class UsageError extends Error {}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = argv[i + 1]
    if (arg === '--stripe-api-key') {
      args.stripeApiKey = next
      i += 1
    } else if (arg === '--db-url') {
      args.dbUrl = next
      i += 1
    } else if (arg === '--help' || arg === '-h') {
      args.help = true
    } else {
      throw new UsageError(`Unknown argument: ${arg}`)
    }
  }
  return args
}

function usage() {
  return [
    'Reconcile Stripe Sigma IDs vs Postgres destination IDs.',
    '',
    'Usage:',
    '  node scripts/reconcile-sigma-vs-postgres.js \\',
    '    --stripe-api-key sk_live_... \\',
    '    --db-url postgresql://user:pass@host:5432/db',
    '',
    'Options:',
    '  --stripe-api-key    Required. Falls back to STRIPE_API_KEY env var.',
    '  --db-url            Optional. Falls back to DATABASE_URL or POSTGRES_URL.',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Postgres — discover tables + counts dynamically
// ---------------------------------------------------------------------------

function discoverPostgresTables(dbUrl) {
  const sql = `
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
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
function fetchPostgresIds(dbUrl, table) {
  const sql = `SELECT id FROM public.${quoteIdent(table)} WHERE id IS NOT NULL;`
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Build a Sigma query that returns (resource, id) rows for the given tables.
 * Tables in `tablesWithDeletedCol` get a WHERE clause that excludes deleted
 * rows so results match what Stripe's `list` endpoints return.
 */
function buildSigmaIdsSql(table, hasDeletedCol) {
  const where = hasDeletedCol ? ' WHERE NOT COALESCE(deleted, false)' : ''
  return `SELECT id FROM "${table}"${where}`
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
  const created = await stripePost(apiKey, '/v1/sigma/query_runs', { sql })
  const completed = await pollSigmaRun(apiKey, created.id)
  const csv = await downloadSigmaResult(apiKey, completed)
  const rows = parseCsv(csv)
  if (rows.length < 2) return new Set()
  const header = rows[0]
  const idIdx = header.indexOf('id')
  if (idIdx === -1) throw new Error(`Sigma result for ${table} missing "id" column`)
  return new Set(
    rows
      .slice(1)
      .map((r) => r[idIdx]?.trim())
      .filter(Boolean)
  )
}

/**
 * Fetch all IDs for a Sigma table. If the table is expected to have a
 * `deleted` column, filter those out; if the filter fails (column doesn't
 * exist after all), retry without it so the run still produces results.
 */
async function fetchSigmaIds(apiKey, table, hasDeletedCol) {
  if (!hasDeletedCol) {
    return runIdsQuery(apiKey, buildSigmaIdsSql(table, false), table)
  }
  try {
    return await runIdsQuery(apiKey, buildSigmaIdsSql(table, true), table)
  } catch (err) {
    // If the deleted column turned out not to exist, retry without the filter.
    const msg = err.errorMessage ?? err.message ?? ''
    if (/column.*deleted|invalid identifier/i.test(msg)) {
      return runIdsQuery(apiKey, buildSigmaIdsSql(table, false), table)
    }
    throw err
  }
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
  'accounts',
  'bank_accounts',
  'cards',
  'coupons',
  'customers',
  'discounts',
  'invoice_line_items',
  'plans',
  'products',
  'skus',
  'subscription_items',
  'subscriptions',
  'tax_ids',
  'terminal_readers',
])

/** Known Postgres → Sigma name aliases. Add entries as you discover more. */
const SIGMA_ALIAS = {
  invoiceitems: 'invoice_line_items',
  tax_ids: 'customer_tax_ids',
  billing_alerts: 'billing_meter_alerts',
}

/**
 * Run one Sigma query per table, with bounded concurrency. Isolates failures
 * (missing table, opaque query error) to the offending table only so one
 * bad table doesn't tank the whole reconcile.
 */
async function runSigmaForResources(apiKey, resources) {
  const skipped = []
  const idsByTable = new Map() // pgTable → Set<id>
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
  const unexpectedErrors = []

  async function runOne({ pgTable, sigmaTable }) {
    try {
      const ids = await fetchSigmaIds(apiKey, sigmaTable, SIGMA_TABLES_WITH_DELETED.has(sigmaTable))
      idsByTable.set(pgTable, ids)
    } catch (err) {
      const missing = detectMissingTables(err)
      if (!missing || !missing.includes(sigmaTable)) {
        unexpectedErrors.push(`${pgTable}: ${err.message}`)
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

  return { idsByTable, skipped }
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

const SAMPLE_SIZE = 5

function diffSets(sigmaIds, pgIds) {
  const common = new Set()
  const pgOnly = new Set()
  const sigmaOnly = new Set()
  for (const id of pgIds) {
    if (sigmaIds.has(id)) common.add(id)
    else pgOnly.add(id)
  }
  for (const id of sigmaIds) {
    if (!pgIds.has(id)) sigmaOnly.add(id)
  }
  return { common, pgOnly, sigmaOnly }
}

function sampleFromSet(set, n) {
  const out = []
  for (const v of set) {
    if (out.length >= n) break
    out.push(v)
  }
  return out
}

function buildComparisonRows(sigmaIdsByTable, postgresIdsByTable, skippedTables) {
  const skippedSet = new Set(skippedTables)
  const resources = new Set([...sigmaIdsByTable.keys(), ...postgresIdsByTable.keys()])

  return [...resources]
    .sort((a, b) => a.localeCompare(b))
    .map((resource) => {
      const sigmaIds = sigmaIdsByTable.get(resource)
      const pgIds = postgresIdsByTable.get(resource) ?? new Set()

      if (skippedSet.has(resource) || sigmaIds === undefined) {
        return {
          resource,
          sigmaCount: null,
          postgresCount: pgIds.size,
          matches: null,
          pgOnly: null,
          sigmaOnly: null,
          status: 'skipped_in_sigma',
          samples: { pgOnly: [], sigmaOnly: [] },
        }
      }

      const { common, pgOnly, sigmaOnly } = diffSets(sigmaIds, pgIds)
      const status = pgOnly.size === 0 && sigmaOnly.size === 0 ? 'match' : 'diff'

      return {
        resource,
        sigmaCount: sigmaIds.size,
        postgresCount: pgIds.size,
        matches: common.size,
        pgOnly: pgOnly.size,
        sigmaOnly: sigmaOnly.size,
        status,
        samples: {
          pgOnly: sampleFromSet(pgOnly, SAMPLE_SIZE),
          sigmaOnly: sampleFromSet(sigmaOnly, SAMPLE_SIZE),
        },
      }
    })
}

function formatTable(rows) {
  const headers = ['resource', 'sigma', 'postgres', 'matches', 'pg_only', 'sigma_only', 'status']
  const stringRows = rows.map((r) => [
    r.resource,
    r.sigmaCount?.toString() ?? '-',
    r.postgresCount?.toString() ?? '-',
    r.matches?.toString() ?? '-',
    r.pgOnly?.toString() ?? '-',
    r.sigmaOnly?.toString() ?? '-',
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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(usage())
    return
  }

  const apiKey = args.stripeApiKey ?? process.env.STRIPE_API_KEY
  if (!apiKey) throw new UsageError('Provide --stripe-api-key or set STRIPE_API_KEY')

  const dbUrl = args.dbUrl ?? process.env.DATABASE_URL ?? process.env.POSTGRES_URL
  if (!dbUrl) throw new UsageError('Provide --db-url or set DATABASE_URL / POSTGRES_URL')

  // Step 1: discover tables from Postgres
  console.error('Discovering tables from Postgres...')
  const pgTables = discoverPostgresTables(dbUrl)
  console.error(`  found ${pgTables.length} tables`)

  // Step 2: fetch IDs for every PG table (serial to avoid overloading psql)
  console.error(`Fetching IDs from Postgres (${pgTables.length} tables)...`)
  const postgresIdsByTable = new Map()
  let pgDone = 0
  for (const table of pgTables) {
    try {
      const ids = await fetchPostgresIds(dbUrl, table)
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

  // Step 3: fetch IDs from Sigma for tables that exist there
  const { idsByTable: sigmaIdsByTable, skipped } = await runSigmaForResources(apiKey, pgTables)

  // Step 4: compare + print
  const rows = buildComparisonRows(sigmaIdsByTable, postgresIdsByTable, skipped)
  const matchCount = rows.filter((r) => r.status === 'match').length
  const diffCount = rows.filter((r) => r.status === 'diff').length
  const skippedCount = rows.filter((r) => r.status === 'skipped_in_sigma').length
  const skippedRows = rows.filter((r) => r.status === 'skipped_in_sigma')
  const diffRows = rows.filter((r) => r.status === 'diff')

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

  if (skippedRows.length > 0) {
    console.log('')
    console.log('Skipped tables (not available in Sigma):')
    for (const r of skippedRows) {
      console.log(`  ${r.resource} (${r.postgresCount ?? 0} rows in postgres)`)
    }
  }

  console.log('')
  console.log(formatTable(rows.filter((r) => r.status !== 'skipped_in_sigma')))

  if (diffRows.length > 0) {
    console.log('')
    console.log('Sample IDs for diffs:')
    for (const r of diffRows) {
      if (r.pgOnly > 0) {
        console.log(
          `  ${r.resource} pg_only (${r.pgOnly}): ${r.samples.pgOnly.join(', ')}${
            r.pgOnly > r.samples.pgOnly.length ? ', ...' : ''
          }`
        )
      }
      if (r.sigmaOnly > 0) {
        console.log(
          `  ${r.resource} sigma_only (${r.sigmaOnly}): ${r.samples.sigmaOnly.join(', ')}${
            r.sigmaOnly > r.samples.sigmaOnly.length ? ', ...' : ''
          }`
        )
      }
    }
  }

  if (diffCount > 0) process.exitCode = 1
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
