/**
 * PixelDraw — Metronome + Redis entitlement demo.
 *
 * Each pixel drawn sends a usage event to Metronome (color = event type).
 * Customer balance is checked in Redis — synced from Metronome via sync-engine.
 * NO local state in Redis. The only data is replicated from Metronome.
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

/** redis://host:port for logs and API — never prints username/password */
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

if (!METRONOME_API_TOKEN) {
  console.error('ERROR: Set METRONOME_API_TOKEN')
  process.exit(1)
}
if (!METRONOME_CUSTOMER_ID) {
  console.error('ERROR: Set METRONOME_CUSTOMER_ID')
  process.exit(1)
}

const redis = new Redis(REDIS_URL)

// ---- Redis reads (Metronome-synced data only) ----

/** Get customer net balance from Metronome-synced Redis data */
async function getCreditBalance() {
  const raw = await redis.get(`${KEY_PREFIX}net_balance:${METRONOME_CUSTOMER_ID}`)
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
async function getEntitlement(productName) {
  const keys = await scanKeys(`${KEY_PREFIX}entitlements:${METRONOME_CUSTOMER_ID}:*`)
  for (const key of keys) {
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
async function scanKeys(pattern) {
  const keys = []
  let cursor = '0'
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100)
    cursor = next
    keys.push(...batch)
  } while (cursor !== '0')
  return keys
}

// ---- Metronome usage ingestion ----

async function postIngestBatch(batch) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(`${METRONOME_BASE_URL}/v1/ingest`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${METRONOME_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(batch),
    })

    if (res.ok) return

    const text = await res.text()
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
    await redis.ping()
    res.json({
      ok: true,
      redis: 'connected',
      redisTarget: REDIS_TARGET_LABEL,
      keyPrefix: KEY_PREFIX,
      usageEventsPerPixel: PIXEL_USAGE_EVENTS_PER_DRAW,
      estimatedCreditsPerPixel: PIXEL_USAGE_EVENTS_PER_DRAW * 0.01,
      ingestBatchDelayMs: METRONOME_INGEST_BATCH_DELAY_MS,
    })
  } catch {
    res.status(503).json({
      ok: false,
      redis: 'disconnected',
      keyPrefix: KEY_PREFIX,
      usageEventsPerPixel: PIXEL_USAGE_EVENTS_PER_DRAW,
    })
  }
})

/** Get current credit balance + entitlements from Metronome-synced Redis */
app.get('/api/credits', async (_req, res) => {
  const balanceInfo = await getCreditBalance()
  const entitlement = await getEntitlement('API Access')
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
  if (balanceInfo.balance <= 0) {
    return res.status(402).json({
      allowed: false,
      error: 'Out of credits',
      balance: 0,
      syncedAt: balanceInfo.syncedAt,
    })
  }

  // 2. Send usage event to Metronome (async, don't block response)
  ingestUsage(color, x, y).catch((err) => {
    console.error('Usage ingest error:', err.message)
  })

  res.json({
    allowed: true,
    balance: balanceInfo.balance,
    syncedAt: balanceInfo.syncedAt,
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
|  Balance: Metronome-synced only (no local state) |
|  Usage sent to Metronome (async)                 |
+==================================================+
  `)
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
