#!/usr/bin/env -S node --conditions bun --import tsx
/**
 * Deterministic Stripe mock server for large-scale sync benchmarking.
 *
 * Generates 30M records per stream (customers, products, prices) on-the-fly
 * from record index — no database, no external deps, just node:http.
 *
 * Usage:
 *   node --conditions bun --import tsx scripts/bench-mock-server.ts
 *   # or
 *   npx tsx scripts/bench-mock-server.ts
 *
 * Env vars:
 *   MOCK_PORT           — listen port (default 9111)
 *   TOTAL_RECORDS       — records per stream (default 30000000)
 *   RANDOM_500_RATE     — fraction of list requests that 500 randomly (default 0.02)
 *   PRICES_ERROR_AFTER  — hard-fail prices after this many records served (default 5000000)
 *   LOG_REQUESTS        — set to 0 to suppress per-request logs
 */

import http from 'node:http'

// ─── Configuration ────────────────────────────────────────────────────────────

const TOTAL = Number(process.env.TOTAL_RECORDS ?? 30_000_000)
const ACCOUNT_CREATED = 1_461_801_600 // 2016-04-28 00:00:00 UTC
const NOW_UNIX = 1_777_377_600 // 2026-04-28 00:00:00 UTC
const TIME_SPAN = NOW_UNIX - ACCOUNT_CREATED // ~315,576,000 seconds (10 years)
const STEP = TIME_SPAN / TOTAL // ~10.519 seconds per record

const RANDOM_500_RATE = Number(process.env.RANDOM_500_RATE ?? 0.02)
const PRICES_ERROR_AFTER = Number(process.env.PRICES_ERROR_AFTER ?? 5_000_000)
const PORT = Number(process.env.MOCK_PORT ?? 9111)
const LOG = process.env.LOG_REQUESTS !== '0'

// ─── Counters ─────────────────────────────────────────────────────────────────

let pricesServed = 0
let totalRequests = 0
let totalRecordsServed = 0
const perPath: Record<string, number> = {}

// ─── Index ↔ Created ──────────────────────────────────────────────────────────

/** Record index (0-based) → Unix created timestamp. Uses STEP to avoid overflow. */
function idxToCreated(i: number): number {
  return ACCOUNT_CREATED + Math.floor(i * STEP)
}

/**
 * Convert created-time bounds to an inclusive index range [lo, hi].
 * Handles gte/gt/lt/lte combinations.
 */
function createdBoundsToRange(
  gte: number | null,
  gt: number | null,
  lt: number | null,
  lte: number | null
): [lo: number, hi: number] {
  // Normalise gt → gte+1, lte → lt-1
  const lower = gte ?? (gt != null ? gt + 1 : null)
  const upper = lt ?? (lte != null ? lte + 1 : null)

  const lo =
    lower != null ? Math.max(0, Math.ceil((lower - ACCOUNT_CREATED) / STEP)) : 0
  const hi =
    upper != null
      ? Math.min(TOTAL - 1, Math.ceil((upper - ACCOUNT_CREATED) / STEP) - 1)
      : TOTAL - 1

  return [lo, hi]
}

// ─── ID helpers ───────────────────────────────────────────────────────────────

const PAD = 10

function makeId(prefix: string, i: number): string {
  return prefix + String(i + 1).padStart(PAD, '0')
}

function parseIdx(id: string, prefix: string): number | null {
  if (!id.startsWith(prefix)) return null
  const n = parseInt(id.slice(prefix.length), 10)
  return isNaN(n) || n < 1 ? null : n - 1 // 0-based
}

// ─── Record generators ───────────────────────────────────────────────────────

function makeCustomer(i: number): Record<string, unknown> {
  const created = idxToCreated(i)
  return {
    id: makeId('cus_', i),
    object: 'customer',
    created,
    email: `bench${i + 1}@example.com`,
    name: `Bench Customer ${i + 1}`,
    livemode: false,
    description: `Customer account #${i + 1} created for large-scale benchmark testing of the sync engine pipeline with realistic Stripe object sizes`,
    currency: 'usd',
    balance: (i % 100000) * 100,
    delinquent: i % 50 === 0,
    discount: i % 20 === 0 ? {
      id: `di_${String(i + 1).padStart(10, '0')}`,
      object: 'discount',
      coupon: { id: `coup_${i % 1000}`, object: 'coupon', amount_off: 500, currency: 'usd', duration: 'once', name: `Bench Coupon ${i % 1000}` },
      start: created,
      end: created + 86400 * 30,
      subscription: null,
    } : null,
    invoice_settings: {
      custom_fields: [{ name: 'Department', value: `Dept-${i % 500}` }, { name: 'PO', value: `PO-${i}` }],
      default_payment_method: `pm_${String(i + 1).padStart(10, '0')}`,
      footer: `Invoice footer for customer ${i + 1}. Please remit payment within 30 days of receipt. Questions? Contact billing@example.com ref #${i + 1}.`,
      rendering_options: { amount_tax_display: 'include_inclusive_tax' },
    },
    metadata: {
      segment: ['enterprise', 'mid-market', 'smb', 'startup'][i % 4],
      region: ['us-east', 'us-west', 'eu-central', 'apac', 'latam'][i % 5],
      tier: ['free', 'pro', 'business', 'enterprise'][i % 4],
      signup_source: ['organic', 'referral', 'paid', 'partner'][i % 4],
      internal_id: `int_${String(i + 1).padStart(12, '0')}`,
      account_manager: `am_${i % 200}`,
      renewal_date: new Date((created + 365 * 86400) * 1000).toISOString().slice(0, 10),
    },
    phone: `+1${String(2000000000 + (i % 8000000000)).padStart(10, '0')}`,
    preferred_locales: ['en', 'fr', 'de', 'es', 'ja'].slice(0, 1 + (i % 3)),
    shipping: {
      address: {
        city: ['New York', 'San Francisco', 'London', 'Tokyo', 'Berlin'][i % 5],
        country: ['US', 'US', 'GB', 'JP', 'DE'][i % 5],
        line1: `${100 + (i % 9900)} ${['Main St', 'Oak Ave', 'Elm Dr', 'Park Rd', 'Broadway'][i % 5]}`,
        line2: i % 3 === 0 ? `Suite ${100 + (i % 900)}` : null,
        postal_code: String(10000 + (i % 90000)),
        state: ['NY', 'CA', 'LDN', 'TK', 'BE'][i % 5],
      },
      name: `Bench Customer ${i + 1}`,
      phone: `+1${String(2000000000 + (i % 8000000000)).padStart(10, '0')}`,
    },
    tax_exempt: ['none', 'exempt', 'reverse'][i % 3],
    test_clock: null,
    address: {
      city: ['New York', 'San Francisco', 'London', 'Tokyo', 'Berlin'][i % 5],
      country: ['US', 'US', 'GB', 'JP', 'DE'][i % 5],
      line1: `${100 + (i % 9900)} ${['Main St', 'Oak Ave', 'Elm Dr', 'Park Rd', 'Broadway'][i % 5]}`,
      line2: i % 3 === 0 ? `Suite ${100 + (i % 900)}` : null,
      postal_code: String(10000 + (i % 90000)),
      state: ['NY', 'CA', 'LDN', 'TK', 'BE'][i % 5],
    },
    default_source: `card_${String(i + 1).padStart(10, '0')}`,
    invoice_prefix: `INV${String(i + 1).padStart(8, '0')}`,
    next_invoice_sequence: i + 1,
    sources: { object: 'list', data: [], has_more: false, url: `/v1/customers/${makeId('cus_', i)}/sources` },
    subscriptions: { object: 'list', data: [], has_more: false, url: `/v1/customers/${makeId('cus_', i)}/subscriptions` },
    tax_ids: { object: 'list', data: [], has_more: false, url: `/v1/customers/${makeId('cus_', i)}/tax_ids` },
    tax: { automatic_tax: 'supported', ip_address: null, location: { country: ['US', 'US', 'GB', 'JP', 'DE'][i % 5], state: ['NY', 'CA', null, null, null][i % 5], source: 'shipping_destination' } },
    invoice_credit_balance: { usd: (i % 1000) * 100 },
    cash_balance: { object: 'cash_balance', available: null, customer: makeId('cus_', i), livemode: false, settings: { reconciliation_mode: 'automatic' } },
  }
}

function makeProduct(i: number): Record<string, unknown> {
  const created = idxToCreated(i)
  return {
    id: makeId('prod_', i),
    object: 'product',
    created,
    updated: created + (i % 86400),
    name: `Bench Product ${i + 1} — ${['Basic', 'Pro', 'Enterprise', 'Starter', 'Premium'][i % 5]} Plan`,
    active: i % 10 !== 0,
    livemode: false,
    description: `Full-featured ${['SaaS', 'API', 'Platform', 'Marketplace', 'Infrastructure'][i % 5]} product for ${['small business', 'enterprise', 'developer', 'startup', 'agency'][i % 5]} customers. Includes ${10 + (i % 90)} API calls/mo, ${1 + (i % 10)} team seats, and ${['basic', 'priority', 'premium', 'dedicated', '24/7'][i % 5]} support.`,
    images: [
      `https://files.stripe.com/links/prod_img_${String(i + 1).padStart(10, '0')}_1`,
      `https://files.stripe.com/links/prod_img_${String(i + 1).padStart(10, '0')}_2`,
    ],
    metadata: {
      category: ['software', 'services', 'hardware', 'subscription', 'addon'][i % 5],
      internal_sku: `SKU-${String(i + 1).padStart(8, '0')}`,
      department: `dept_${i % 50}`,
      launch_date: new Date(created * 1000).toISOString().slice(0, 10),
    },
    type: 'service',
    default_price: makeId('price_', i),
    statement_descriptor: `BENCH*PROD${String(i + 1).padStart(6, '0')}`.slice(0, 22),
    unit_label: ['seat', 'unit', 'call', 'GB', 'request'][i % 5],
    url: `https://example.com/products/${makeId('prod_', i)}`,
    features: [
      { name: `Feature A for product ${i + 1}` },
      { name: `Feature B for product ${i + 1}` },
      { name: `Feature C for product ${i + 1}` },
    ],
    tax_code: `txcd_${String(10000000 + (i % 90000000))}`,
    package_dimensions: i % 7 === 0 ? { height: 10.5, length: 20.0, weight: 1.5, width: 15.0 } : null,
    shippable: i % 7 === 0,
    marketing_features: [
      { name: `${['Unlimited', 'Advanced', 'Premium', 'Enterprise', 'Core'][i % 5]} analytics` },
      { name: `${['Real-time', 'Daily', 'Weekly', 'Monthly', 'Custom'][i % 5]} reporting` },
    ],
  }
}

function makePrice(i: number): Record<string, unknown> {
  const created = idxToCreated(i)
  const isRecurring = i % 3 !== 0
  return {
    id: makeId('price_', i),
    object: 'price',
    created,
    product: makeId('prod_', i % 1_000_000),
    currency: ['usd', 'eur', 'gbp', 'jpy', 'cad'][i % 5],
    unit_amount: 100 + (i % 99_900),
    unit_amount_decimal: String(100 + (i % 99_900)),
    active: i % 15 !== 0,
    livemode: false,
    nickname: `${['Monthly', 'Annual', 'Quarterly', 'One-time', 'Usage'][i % 5]} — Tier ${1 + (i % 10)}`,
    recurring: isRecurring ? {
      aggregate_usage: i % 6 === 0 ? 'sum' : null,
      interval: ['month', 'year', 'week', 'month', 'year'][i % 5],
      interval_count: [1, 1, 1, 3, 1][i % 5],
      meter: null,
      trial_period_days: i % 10 === 0 ? 14 : null,
      usage_type: i % 6 === 0 ? 'metered' : 'licensed',
    } : null,
    type: isRecurring ? 'recurring' : 'one_time',
    metadata: {
      plan_tier: ['free', 'basic', 'pro', 'enterprise'][i % 4],
      pricing_model: ['flat', 'per_seat', 'usage', 'tiered'][i % 4],
      internal_price_id: `ip_${String(i + 1).padStart(12, '0')}`,
    },
    billing_scheme: i % 8 === 0 ? 'tiered' : 'per_unit',
    lookup_key: `price_lookup_${['basic', 'pro', 'enterprise', 'starter'][i % 4]}_${['monthly', 'annual'][i % 2]}`,
    tiers_mode: i % 8 === 0 ? 'graduated' : null,
    tiers: i % 8 === 0 ? [
      { up_to: 100, unit_amount: 1000, flat_amount: null },
      { up_to: 1000, unit_amount: 800, flat_amount: null },
      { up_to: null, unit_amount: 500, flat_amount: null },
    ] : null,
    transform_quantity: i % 12 === 0 ? { divide_by: 100, round: 'up' } : null,
    tax_behavior: ['unspecified', 'inclusive', 'exclusive'][i % 3],
    custom_unit_amount: i % 20 === 0 ? { maximum: 100000, minimum: 100, preset: 5000 } : null,
    currency_options: {
      eur: { unit_amount: Math.round((100 + (i % 99_900)) * 0.92), tax_behavior: 'exclusive' },
      gbp: { unit_amount: Math.round((100 + (i % 99_900)) * 0.79), tax_behavior: 'exclusive' },
    },
  }
}

// ─── Stream definitions ──────────────────────────────────────────────────────

type StreamDef = {
  prefix: string
  generate: (i: number) => Record<string, unknown>
}

const STREAMS: Record<string, StreamDef> = {
  '/v1/customers': { prefix: 'cus_', generate: makeCustomer },
  '/v1/products': { prefix: 'prod_', generate: makeProduct },
  '/v1/prices': { prefix: 'price_', generate: makePrice },
}

// ─── Fake account ────────────────────────────────────────────────────────────

const ACCOUNT = {
  id: 'acct_bench_mock_000',
  object: 'account',
  type: 'standard',
  charges_enabled: true,
  payouts_enabled: true,
  details_submitted: true,
  business_type: 'company',
  country: 'US',
  default_currency: 'usd',
  email: 'bench@example.com',
  created: ACCOUNT_CREATED,
  settings: { dashboard: { display_name: 'Bench Mock Account' } },
}

// ─── Pagination ──────────────────────────────────────────────────────────────

/**
 * Serve a page of records within index range [lo, hi] (inclusive),
 * sorted descending (highest index first — matches Stripe's created DESC, id DESC).
 */
function servePage(
  lo: number,
  hi: number,
  cursorIdx: number | null,
  limit: number,
  generate: (i: number) => Record<string, unknown>
): { data: Record<string, unknown>[]; has_more: boolean } {
  if (lo > hi) return { data: [], has_more: false }

  // Start from cursor-1 (the record after the cursor in desc order), or hi
  const startIdx = cursorIdx !== null ? Math.min(cursorIdx - 1, hi) : hi
  if (startIdx < lo) return { data: [], has_more: false }

  const fetchLimit = limit + 1
  const items: Record<string, unknown>[] = []
  for (let i = startIdx; i >= lo && items.length < fetchLimit; i--) {
    items.push(generate(i))
  }

  const has_more = items.length > limit
  return { data: items.slice(0, limit), has_more }
}

// ─── HTTP handler ────────────────────────────────────────────────────────────

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url!, `http://localhost:${PORT}`)
  const path = url.pathname
  totalRequests++
  perPath[path] = (perPath[path] ?? 0) + 1

  if (LOG && path !== '/health') {
    process.stderr.write(`[mock] ${req.method} ${path}${url.search}\n`)
  }

  // ── Health ──────────────────────────────────────────────────────
  if (path === '/health') {
    sendJson(res, 200, {
      ok: true,
      total_requests: totalRequests,
      total_records_served: totalRecordsServed,
      prices_served: pricesServed,
      prices_error_after: PRICES_ERROR_AFTER,
    })
    return
  }

  // ── Account ─────────────────────────────────────────────────────
  if (path === '/v1/account') {
    sendJson(res, 200, ACCOUNT)
    return
  }

  // ── Stream list endpoints ───────────────────────────────────────
  const stream = STREAMS[path]
  if (stream) {
    // Prices hard failure after threshold
    if (path === '/v1/prices' && pricesServed >= PRICES_ERROR_AFTER) {
      sendJson(res, 500, {
        error: {
          type: 'api_error',
          message: `Prices stream hard-fail: ${pricesServed.toLocaleString()} records already served (limit: ${PRICES_ERROR_AFTER.toLocaleString()})`,
        },
      })
      return
    }

    // Random 500 injection (recoverable via retry)
    if (Math.random() < RANDOM_500_RATE) {
      sendJson(res, 500, {
        error: {
          type: 'api_error',
          message: 'Injected random server error (bench-mock)',
        },
      })
      return
    }

    const q = url.searchParams
    const limit = clampLimit(q.get('limit'))
    const startingAfter = q.get('starting_after')
    const gte = intParam(q.get('created[gte]'))
    const gt = intParam(q.get('created[gt]'))
    const lt = intParam(q.get('created[lt]'))
    const lte = intParam(q.get('created[lte]'))

    const [lo, hi] = createdBoundsToRange(gte, gt, lt, lte)
    const cursorIdx = startingAfter ? parseIdx(startingAfter, stream.prefix) : null

    const { data, has_more } = servePage(lo, hi, cursorIdx, limit, stream.generate)

    // Track records served
    totalRecordsServed += data.length
    if (path === '/v1/prices') {
      pricesServed += data.length
    }

    sendJson(res, 200, {
      object: 'list',
      url: path,
      has_more,
      data,
    })
    return
  }

  // ── Catch-all: 404 for unknown endpoints (skippable by source) ─
  sendJson(res, 404, {
    error: {
      type: 'invalid_request_error',
      message: `Unrecognized request URL (${req.method}: ${path}). Please see https://stripe.com/docs or we can help at https://support.stripe.com/.`,
    },
  })
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  })
  res.end(json)
}

function clampLimit(raw: string | null): number {
  if (raw == null) return 100
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 1) return 100
  return Math.min(n, 100)
}

function intParam(raw: string | null): number | null {
  if (raw == null) return null
  const n = parseInt(raw, 10)
  return Number.isFinite(n) ? n : null
}

// ─── Start ───────────────────────────────────────────────────────────────────

const server = http.createServer(handleRequest)

server.listen(PORT, '0.0.0.0', () => {
  const sep = '━'.repeat(60)
  process.stderr.write(
    `\n${sep}\n` +
      `  Bench Mock Stripe Server\n` +
      `${sep}\n` +
      `  URL:            http://0.0.0.0:${PORT}\n` +
      `  Streams:        customers, products, prices\n` +
      `  Records/stream: ${TOTAL.toLocaleString()}\n` +
      `  Time span:      2016-04-28 → 2026-04-28 (10 years)\n` +
      `  Random 500s:    ${(RANDOM_500_RATE * 100).toFixed(1)}% of list requests\n` +
      `  Prices fail at: ${PRICES_ERROR_AFTER.toLocaleString()} records served\n` +
      `${sep}\n\n`
  )
})

// Graceful shutdown with stats
function shutdown() {
  const sep = '━'.repeat(60)
  process.stderr.write(
    `\n${sep}\n` +
      `  Shutting down\n` +
      `${sep}\n` +
      `  Total requests:      ${totalRequests.toLocaleString()}\n` +
      `  Total records served: ${totalRecordsServed.toLocaleString()}\n` +
      `  Prices served:       ${pricesServed.toLocaleString()} / ${PRICES_ERROR_AFTER.toLocaleString()}\n`
  )
  const sorted = Object.entries(perPath).sort((a, b) => b[1] - a[1])
  for (const [p, count] of sorted) {
    process.stderr.write(`  ${String(count).padStart(8)} reqs  ${p}\n`)
  }
  process.stderr.write(`${sep}\n`)
  server.close()
  process.exit(0)
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
