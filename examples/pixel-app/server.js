/**
 * PixelDraw — Metronome + Redis entitlement demo.
 *
 * Each pixel drawn sends usage to Metronome.
 * Customer balance is checked in Redis, which is synced from Metronome by Sync Engine.
 * The app never reads Metronome directly for balance or entitlement checks.
 *
 * Architecture:
 *   Browser → POST /api/draw → check Metronome-synced Redis balance → send usage to Metronome
 *   Metronome → webhook → source-metronome → destination-redis (keeps Redis fresh)
 *
 * Env vars:
 *   METRONOME_API_TOKEN   — Metronome bearer token
 *   METRONOME_CUSTOMER_ID — Customer ID in Metronome
 *   REDIS_URL             — Redis connection (default: redis://localhost:56379)
 *   PORT                  — Server port (default: 4000)
 *   MIN_CREDITS_TO_DRAW   — Redis-backed balance required to draw (default: 60)
 *   PIXEL_USAGE_EVENTS_PER_DRAW — Metronome api_call events per pixel (default: 100)
 *   METRONOME_INGEST_BATCH_DELAY_MS — delay between 100-event ingest batches (default: 0)
 */

import express from 'express'
import { Redis } from 'ioredis'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

const app = express()
app.use(express.json())
app.use(express.static(join(__dirname, 'public')))

const PORT = process.env.PORT || 4000
const METRONOME_API_TOKEN = process.env.METRONOME_API_TOKEN
const METRONOME_CUSTOMER_ID = process.env.METRONOME_CUSTOMER_ID
const METRONOME_BASE_URL = process.env.METRONOME_BASE_URL || 'https://api.metronome.com'
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:56379'
const KEY_PREFIX = process.env.KEY_PREFIX || 'sync:'
const SYNC_ENGINE_WEBHOOK_URL = process.env.SYNC_ENGINE_WEBHOOK_URL || 'http://127.0.0.1:4244'
const MIN_CREDITS_TO_DRAW = Math.max(
  0,
  Number.parseInt(process.env.MIN_CREDITS_TO_DRAW || '60', 10) || 60
)
const PIXEL_USAGE_EVENTS_PER_DRAW = Math.max(
  1,
  Number.parseInt(process.env.PIXEL_USAGE_EVENTS_PER_DRAW || '100', 10) || 100
)
const METRONOME_INGEST_BATCH_SIZE = 100
const METRONOME_INGEST_BATCH_DELAY_MS_RAW = Number.parseInt(
  process.env.METRONOME_INGEST_BATCH_DELAY_MS ?? '0',
  10
)
const METRONOME_INGEST_BATCH_DELAY_MS = Number.isFinite(METRONOME_INGEST_BATCH_DELAY_MS_RAW)
  ? Math.max(0, METRONOME_INGEST_BATCH_DELAY_MS_RAW)
  : 0

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function customerLabel() {
  return `${METRONOME_CUSTOMER_ID.slice(0, 8)}...${METRONOME_CUSTOMER_ID.slice(-4)}`
}

const LOG_COLORS = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
}

function colorForEvent(event) {
  if (process.env.NO_COLOR) return ''
  if (event.startsWith('redis.')) return LOG_COLORS.red
  if (event.startsWith('metronome.')) return LOG_COLORS.green
  return ''
}

function logDemo(event, data = {}) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    component: 'pixeldraw',
    event,
    ...data,
  })
  const color = colorForEvent(event)
  console.log(color ? `${color}${line}${LOG_COLORS.reset}` : line)
}

/** redis://host:port for logs and API responses; never prints username/password. */
function redisTargetLabel(urlStr) {
  try {
    const normalized = /^[a-z]+:\/\//i.test(urlStr) ? urlStr : `redis://${urlStr}`
    const u = new URL(normalized)
    const host = `${u.hostname || 'localhost'}${u.port ? `:${u.port}` : ''}`
    return `${u.protocol === 'rediss:' ? 'rediss' : 'redis'}://${host}`
  } catch {
    return 'redis://???'
  }
}

const REDIS_TARGET_LABEL = redisTargetLabel(REDIS_URL)
let lastCreditsSnapshot = null

if (!METRONOME_API_TOKEN) {
  console.error('ERROR: Set METRONOME_API_TOKEN')
  process.exit(1)
}
if (!METRONOME_CUSTOMER_ID) {
  console.error('ERROR: Set METRONOME_CUSTOMER_ID')
  process.exit(1)
}

const redis = new Redis(REDIS_URL)
let lastRedisErrorLogAt = 0

redis.on('error', (err) => {
  const now = Date.now()
  if (now - lastRedisErrorLogAt < 5000) return
  lastRedisErrorLogAt = now
  logDemo('redis.error', {
    target: REDIS_TARGET_LABEL,
    error: err instanceof Error ? err.message : String(err),
    purpose: 'Redis sidecar is unavailable; start it with docker compose up redis -d',
  })
})

redis.on('connect', () => {
  logDemo('redis.connect', {
    target: REDIS_TARGET_LABEL,
    purpose: 'PixelDraw reconnected to Redis sidecar',
  })
})

app.use((req, res, next) => {
  if (req.query?.silent === '1') {
    return next()
  }
  const startedAt = Date.now()
  logDemo('browser.request', {
    method: req.method,
    path: req.path,
  })
  res.on('finish', () => {
    logDemo('browser.response', {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
    })
  })
  next()
})

// ---- Redis reads: Metronome-synced data only ----

/** Get customer net balance from Metronome-synced Redis data */
async function getCreditBalance({ log = true } = {}) {
  const key = `${KEY_PREFIX}net_balance:${METRONOME_CUSTOMER_ID}`
  if (log) {
    logDemo('redis.GET', {
      target: REDIS_TARGET_LABEL,
      key,
      customer: customerLabel(),
      purpose: 'read Metronome net_balance materialized by Sync Engine',
    })
  }
  const raw = await redis.get(key)
  if (!raw) {
    return { balance: 0, syncedAt: null, source: 'missing' }
  }

  const netBalance = JSON.parse(raw)
  return {
    balance: Number(netBalance.balance ?? 0),
    syncedAt: netBalance._synced_at ?? null,
    source: 'net_balance',
    creditTypeId: netBalance.credit_type_id ?? null,
  }
}

/** Get entitlement for a specific product from Redis */
async function getEntitlement(productName, { log = true } = {}) {
  const pattern = `${KEY_PREFIX}entitlements:${METRONOME_CUSTOMER_ID}:*`
  const keys = await scanKeys(pattern, { log })
  for (const key of keys) {
    if (log) {
      logDemo('redis.GET', {
        target: REDIS_TARGET_LABEL,
        key,
        customer: customerLabel(),
        purpose: `read ${productName} entitlement materialized by Sync Engine`,
      })
    }
    const raw = await redis.get(key)
    if (!raw) continue
    const ent = JSON.parse(raw)
    if (ent.product_name === productName) {
      return ent
    }
  }
  return null
}

/** Scan Redis keys matching a pattern */
async function scanKeys(pattern, { log = true } = {}) {
  if (log) {
    logDemo('redis.SCAN', {
      target: REDIS_TARGET_LABEL,
      pattern,
      customer: customerLabel(),
      purpose: 'find Metronome entitlement rows materialized by Sync Engine',
    })
  }
  const keys = []
  let cursor = '0'
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100)
    cursor = next
    keys.push(...batch)
  } while (cursor !== '0')
  if (log) {
    logDemo('redis.SCAN.result', {
      target: REDIS_TARGET_LABEL,
      pattern,
      keyCount: keys.length,
    })
  }
  return keys
}

// ---- Metronome usage ingestion ----

async function postIngestBatch(batch) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    logDemo('metronome.POST', {
      host: new URL(METRONOME_BASE_URL).host,
      path: '/v1/ingest',
      eventType: 'api_call',
      eventCount: batch.length,
      customer: customerLabel(),
      attempt,
      purpose: 'write usage only; balance reads stay on Redis',
    })
    const res = await fetch(`${METRONOME_BASE_URL}/v1/ingest`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${METRONOME_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(batch),
    })

    if (res.ok) {
      logDemo('metronome.response', {
        path: '/v1/ingest',
        status: res.status,
        eventCount: batch.length,
      })
      return
    }

    const text = await res.text()
    logDemo('metronome.response', {
      path: '/v1/ingest',
      status: res.status,
      eventCount: batch.length,
      retrying: res.status === 429 && attempt < 4,
    })
    if (res.status !== 429 || attempt === 4) {
      throw new Error(`Metronome ingest failed: ${res.status} ${text}`)
    }

    await sleep(attempt * 1000)
  }
}

async function ingestUsage(color, x, y) {
  const now = Date.now()
  const events = Array.from({ length: PIXEL_USAGE_EVENTS_PER_DRAW }, (_, i) => ({
    customer_id: METRONOME_CUSTOMER_ID,
    event_type: 'api_call',
    timestamp: new Date().toISOString(),
    transaction_id: `px_${now}_${i}_${Math.random().toString(36).slice(2, 8)}`,
    properties: {
      color,
      x,
      y,
      pixel_usage_events: PIXEL_USAGE_EVENTS_PER_DRAW,
    },
  }))

  for (let i = 0; i < events.length; i += METRONOME_INGEST_BATCH_SIZE) {
    const batch = events.slice(i, i + METRONOME_INGEST_BATCH_SIZE)
    await postIngestBatch(batch)
    if (METRONOME_INGEST_BATCH_DELAY_MS > 0 && i + METRONOME_INGEST_BATCH_SIZE < events.length) {
      await sleep(METRONOME_INGEST_BATCH_DELAY_MS)
    }
  }
}

// ---- API routes ----

/** Health check (no secrets returned) */
app.get('/api/health', async (_req, res) => {
  try {
    logDemo('redis.PING', {
      target: REDIS_TARGET_LABEL,
      purpose: 'prove Redis sidecar is reachable',
    })
    await redis.ping()
    res.json({
      ok: true,
      redis: 'connected',
      redisTarget: REDIS_TARGET_LABEL,
      keyPrefix: KEY_PREFIX,
      syncEngineWebhook: SYNC_ENGINE_WEBHOOK_URL,
      readModel: 'Redis sidecar populated by Sync Engine',
      minCreditsToDraw: MIN_CREDITS_TO_DRAW,
      usageEventsPerPixel: PIXEL_USAGE_EVENTS_PER_DRAW,
      estimatedCreditsPerPixel: PIXEL_USAGE_EVENTS_PER_DRAW * 0.01,
      ingestBatchDelayMs: METRONOME_INGEST_BATCH_DELAY_MS,
    })
  } catch {
    res.status(503).json({
      ok: false,
      redis: 'disconnected',
      keyPrefix: KEY_PREFIX,
      minCreditsToDraw: MIN_CREDITS_TO_DRAW,
      usageEventsPerPixel: PIXEL_USAGE_EVENTS_PER_DRAW,
    })
  }
})

/** Get current credit balance + entitlements from Metronome-synced Redis */
app.get('/api/credits', async (req, res) => {
  const silent = req.query.silent === '1'
  const balanceInfo = await getCreditBalance({ log: !silent })
  const entitlement = await getEntitlement('API Access', { log: !silent })
  const snapshot = JSON.stringify({
    balance: balanceInfo.balance,
    syncedAt: balanceInfo.syncedAt,
    minCreditsToDraw: MIN_CREDITS_TO_DRAW,
    entitled: entitlement?.entitled ?? false,
    product: entitlement?.product_name ?? null,
  })
  if (silent && lastCreditsSnapshot !== null && snapshot !== lastCreditsSnapshot) {
    logDemo('redis.change', {
      target: REDIS_TARGET_LABEL,
      key: `${KEY_PREFIX}net_balance:${METRONOME_CUSTOMER_ID}`,
      customer: customerLabel(),
      previous: JSON.parse(lastCreditsSnapshot),
      current: JSON.parse(snapshot),
      purpose: 'silent UI poll noticed Sync Engine refreshed Redis',
    })
  }
  lastCreditsSnapshot = snapshot
  res.json({
    ...balanceInfo,
    entitled: entitlement?.entitled ?? false,
    product: entitlement?.product_name ?? null,
  })
})

/** Draw a pixel — the hot path */
app.post('/api/draw', async (req, res) => {
  const { color, x, y } = req.body
  if (!color || x == null || y == null) {
    return res.status(400).json({ error: 'color, x, y required' })
  }

  // 1. Check Metronome-synced credit balance in Redis
  const balanceInfo = await getCreditBalance()
  if (balanceInfo.balance < MIN_CREDITS_TO_DRAW) {
    logDemo('draw.blocked', {
      reason: 'redis_balance_below_draw_threshold',
      balance: balanceInfo.balance,
      minCreditsToDraw: MIN_CREDITS_TO_DRAW,
      syncedAt: balanceInfo.syncedAt,
    })
    return res.status(402).json({
      allowed: false,
      error: 'Update funds to draw',
      balance: balanceInfo.balance,
      minCreditsToDraw: MIN_CREDITS_TO_DRAW,
      syncedAt: balanceInfo.syncedAt,
    })
  }

  // 2. Send usage event to Metronome (async, don't block response)
  logDemo('draw.allowed', {
    sourceOfTruthRead: 'redis',
    usageWrite: 'metronome',
    syncEngineWebhook: SYNC_ENGINE_WEBHOOK_URL,
    currentBalance: balanceInfo.balance,
    minCreditsToDraw: MIN_CREDITS_TO_DRAW,
    usageEvents: PIXEL_USAGE_EVENTS_PER_DRAW,
  })
  ingestUsage(color, x, y).catch((err) => {
    console.error('Usage ingest error:', err.message)
  })

  res.json({
    allowed: true,
    balance: balanceInfo.balance,
    syncedAt: balanceInfo.syncedAt,
    minCreditsToDraw: MIN_CREDITS_TO_DRAW,
    color,
    x,
    y,
    usageEvents: PIXEL_USAGE_EVENTS_PER_DRAW,
    estimatedCreditsBurned: PIXEL_USAGE_EVENTS_PER_DRAW * 0.01,
  })
})

// ---- Start ----

const server = app
  .listen(PORT, () => {
    console.log(`
+==================================================+
|  PixelDraw — http://localhost:${PORT}              |
|  Metronome customer: ${METRONOME_CUSTOMER_ID.slice(0, 20)}...    |
|  Redis: ${REDIS_TARGET_LABEL.padEnd(42)}|
|  Sync Engine webhook: ${SYNC_ENGINE_WEBHOOK_URL.padEnd(29)}|
|  Draw threshold: ${String(MIN_CREDITS_TO_DRAW).padEnd(31)}|
|  Balance: Metronome-synced only (no local state) |
|  Usage sent to Metronome (async)                 |
+==================================================+
  `)
    logDemo('architecture', {
      browser: `http://localhost:${PORT}`,
      redisSidecar: REDIS_TARGET_LABEL,
      syncEngineWebhook: SYNC_ENGINE_WEBHOOK_URL,
      minCreditsToDraw: MIN_CREDITS_TO_DRAW,
      hotPathReads: ['redis.GET sync:net_balance:*', 'redis.SCAN sync:entitlements:*'],
      usageWrites: ['metronome.POST /v1/ingest'],
      directMetronomeBalanceReads: false,
    })
  })
  .on('error', (err) => {
    console.error('Server failed:', err.code === 'EADDRINUSE' ? `port ${PORT} in use — set PORT=` : err.message)
    process.exit(1)
  })

async function shutdown(reason) {
  if (reason) console.error(String(reason))
  try {
    await redis.quit()
  } catch {}
  server.close(() => process.exit(0))
}
process.once('SIGINT', () => void shutdown())
process.once('SIGTERM', () => void shutdown())
