import { afterAll, beforeAll, describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import pg from 'pg'
import { serve } from '@hono/node-server'
import type { ServerType } from '@hono/node-server'
import {
  startDockerPostgres18,
  createStripeListServer,
  ensureObjectTable,
  upsertObjects,
  applyCreatedTimestampRange,
  type DockerPostgres18Handle,
  type StripeListServer,
} from '@stripe/sync-test-utils'
import { createConnectorResolver, createApp as createEngineApp } from '@stripe/sync-engine'
import sourceStripe from '@stripe/sync-source-stripe'
import destinationPostgres from '@stripe/sync-destination-postgres'

// ---------------------------------------------------------------------------
// Docker helpers
// ---------------------------------------------------------------------------

function dockerPause(containerId: string) {
  execSync(`docker pause ${containerId}`, { stdio: 'pipe' })
}

function dockerUnpause(containerId: string) {
  execSync(`docker unpause ${containerId}`, { stdio: 'pipe' })
}

async function waitForPg(connectionString: string, timeoutMs = 30_000): Promise<void> {
  const pool = new pg.Pool({ connectionString })
  const deadline = Date.now() + timeoutMs
  try {
    while (Date.now() < deadline) {
      try {
        await pool.query('SELECT 1')
        return
      } catch {
        await new Promise((r) => setTimeout(r, 500))
      }
    }
    throw new Error('Postgres did not become ready in time')
  } finally {
    await pool.end().catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const STRIPE_MOCK_URL = 'http://localhost:12111'
const OBJECT_COUNT = 10_000
const SEED_BATCH = 1000

function utc(date: string): number {
  return Math.floor(new Date(date + 'T00:00:00Z').getTime() / 1000)
}

const RANGE_START = utc('2021-04-03')
const RANGE_END = utc('2026-04-02')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (!addr || typeof addr === 'string') {
        reject(new Error('Could not get port'))
        return
      }
      const port = addr.port
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

async function ensureStripeMock(): Promise<void> {
  execSync('docker compose up -d stripe-mock', {
    cwd: new URL('..', import.meta.url).pathname,
    stdio: 'pipe',
  })
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${STRIPE_MOCK_URL}/v1/customers`, {
        headers: { Authorization: 'Bearer sk_test_fake' },
      })
      if (res.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('stripe-mock did not become ready')
}

type NdjsonMessage = {
  type: string
  stream?: string
  data?: unknown
  message?: string
  failure_type?: string
}

function parseNdjsonBody(text: string): NdjsonMessage[] {
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as NdjsonMessage)
}

// ---------------------------------------------------------------------------
// Fault-injecting HTTP proxy (sits between engine and test server)
// ---------------------------------------------------------------------------

type FaultConfig = { errorRate: number; errorCodes: number[] }

// Paths the Stripe SDK calls during source setup — never inject faults here
// so the engine can initialise and we only fault the data-fetching phase.
const SETUP_PATHS = ['/v1/account']

function createFaultProxy(targetUrl: string) {
  const config: FaultConfig = { errorRate: 0, errorCodes: [500, 429] }
  let injectedCount = 0

  const server = http.createServer(async (req, res) => {
    const isSetup = SETUP_PATHS.some((p) => req.url?.startsWith(p))
    if (!isSetup && config.errorRate > 0 && Math.random() < config.errorRate) {
      injectedCount++
      const code = config.errorCodes[Math.floor(Math.random() * config.errorCodes.length)]
      if (code === 429) res.setHeader('Retry-After', '0')
      res.writeHead(code, { 'Content-Type': 'text/plain' })
      res.end(
        code === 429
          ? `Rate limit: Injected fault (429)`
          : `Internal Server Error: Injected fault (${code})`
      )
      return
    }

    const target = `${targetUrl}${req.url}`
    try {
      const upstream = await fetch(target, {
        method: req.method,
        headers: req.headers as Record<string, string>,
      })
      res.writeHead(upstream.status, Object.fromEntries(upstream.headers.entries()))
      if (upstream.body) {
        const reader = upstream.body.getReader()
        const pump = async () => {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            res.write(value)
          }
          res.end()
        }
        pump().catch(() => res.end())
      } else {
        res.end()
      }
    } catch {
      res.writeHead(502)
      res.end('Bad Gateway')
    }
  })

  return {
    server,
    setFaults(f: Partial<FaultConfig>) {
      Object.assign(config, f)
    },
    get injectedCount() {
      return injectedCount
    },
    resetCount() {
      injectedCount = 0
    },
    async listen(): Promise<number> {
      return new Promise((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address()
          if (!addr || typeof addr === 'string') {
            reject(new Error('Could not get port'))
            return
          }
          resolve(addr.port)
        })
        server.on('error', reject)
      })
    },
    close(): Promise<void> {
      return new Promise((resolve) => server.close(() => resolve()))
    },
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('e2e: engine HTTP API under fault conditions', () => {
  let sourceDocker: DockerPostgres18Handle
  let destDocker: DockerPostgres18Handle
  let testServer: StripeListServer
  let sourcePool: pg.Pool
  let destPool: pg.Pool
  let customerTemplate: Record<string, unknown>

  let faultProxy: ReturnType<typeof createFaultProxy>
  let faultProxyUrl: string

  let engineServer: ServerType
  let engineUrl: string

  let schemaCounter = 0
  function nextSchema(): string {
    return `e2e_fault_${Date.now()}_${schemaCounter++}`
  }

  beforeAll(async () => {
    await ensureStripeMock()

    const [src, dest, tmpl] = await Promise.all([
      startDockerPostgres18(),
      startDockerPostgres18(),
      fetch(`${STRIPE_MOCK_URL}/v1/customers`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer sk_test_fake',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }).then((r) => r.json() as Promise<Record<string, unknown>>),
    ])
    sourceDocker = src
    destDocker = dest
    customerTemplate = tmpl

    sourcePool = new pg.Pool({ connectionString: sourceDocker.connectionString })
    destPool = new pg.Pool({ connectionString: destDocker.connectionString })

    testServer = await createStripeListServer({
      postgresUrl: sourceDocker.connectionString,
      accountCreated: RANGE_START,
    })

    await ensureObjectTable(sourcePool, 'stripe', 'customers')
    const shells = Array.from({ length: OBJECT_COUNT }, (_, i) => ({
      ...customerTemplate,
      id: `cus_e2e_${String(i).padStart(5, '0')}`,
      created: 0,
    }))
    const objects = applyCreatedTimestampRange(shells, {
      startUnix: RANGE_START,
      endUnix: RANGE_END,
    })
    for (let i = 0; i < objects.length; i += SEED_BATCH) {
      await upsertObjects(sourcePool, 'stripe', 'customers', objects.slice(i, i + SEED_BATCH))
    }

    faultProxy = createFaultProxy(testServer.url)
    const faultPort = await faultProxy.listen()
    faultProxyUrl = `http://127.0.0.1:${faultPort}`

    const connectors = createConnectorResolver({
      sources: { stripe: sourceStripe },
      destinations: { postgres: destinationPostgres },
    })
    const enginePort = await findFreePort()
    const engineApp = createEngineApp(connectors)
    engineServer = serve({ fetch: engineApp.fetch, port: enginePort })
    engineUrl = `http://127.0.0.1:${enginePort}`

    console.log(`  Source PG:    ${sourceDocker.connectionString}`)
    console.log(`  Dest PG:      ${destDocker.connectionString}`)
    console.log(`  Test server:  ${testServer.url}`)
    console.log(`  Fault proxy:  ${faultProxyUrl}`)
    console.log(`  Engine API:   ${engineUrl}`)
  }, 5 * 60_000)

  afterAll(async () => {
    engineServer?.close()
    await faultProxy?.close().catch(() => {})
    await testServer?.close().catch(() => {})
    await sourcePool?.end().catch(() => {})
    await destPool?.end().catch(() => {})
    destDocker?.stop()
    sourceDocker?.stop()
  }, 60_000)

  // -------------------------------------------------------------------------
  // POST /sync helper
  // -------------------------------------------------------------------------

  async function callSync(opts: {
    destSchema: string
    state?: Record<string, unknown>
    stateCheckpointLimit?: number
    timeoutMs?: number
  }): Promise<{ messages: NdjsonMessage[]; state: Record<string, unknown> }> {
    const pipeline = {
      source: {
        type: 'stripe',
        api_key: 'sk_test_fake',
        api_version: '2025-04-30.basil',
        base_url: faultProxyUrl,
        rate_limit: 10_000,
        backfill_concurrency: 5,
      },
      destination: {
        type: 'postgres',
        connection_string: destDocker.connectionString,
        schema: opts.destSchema,
        batch_size: 100,
      },
      streams: [{ name: 'customers', sync_mode: 'full_refresh' }],
    }

    const headers: Record<string, string> = {
      'X-Pipeline': JSON.stringify(pipeline),
    }
    if (opts.state) {
      headers['X-State'] = JSON.stringify(opts.state)
    }
    if (opts.stateCheckpointLimit) {
      headers['X-State-Checkpoint-Limit'] = String(opts.stateCheckpointLimit)
    }

    const fetchOpts: RequestInit = { method: 'POST', headers }
    if (opts.timeoutMs) {
      fetchOpts.signal = AbortSignal.timeout(opts.timeoutMs)
    }

    const res = await fetch(`${engineUrl}/sync`, fetchOpts)
    const text = await res.text()
    const messages = parseNdjsonBody(text)

    const state = { ...(opts.state ?? {}) }
    for (const msg of messages) {
      if (msg.type === 'state' && msg.stream) {
        state[msg.stream] = msg.data
      }
    }

    return { messages, state }
  }

  function destRowCount(schema: string): Promise<number> {
    return destPool
      .query(`SELECT count(*)::int AS c FROM "${schema}"."customers"`)
      .then((r) => r.rows[0].c)
      .catch(() => 0)
  }

  function destIds(schema: string): Promise<Set<string>> {
    return destPool
      .query(`SELECT id FROM "${schema}"."customers" ORDER BY id`)
      .then((r) => new Set(r.rows.map((row: { id: string }) => row.id)))
      .catch(() => new Set())
  }

  // -------------------------------------------------------------------------
  // 1. Baseline: clean sync completes with zero errors
  // -------------------------------------------------------------------------

  it(
    'clean sync with no faults produces zero errors and all objects',
    async () => {
      const schema = nextSchema()
      faultProxy.setFaults({ errorRate: 0 })

      let state: Record<string, unknown> = {}
      const allMessages: NdjsonMessage[] = []

      for (let i = 0; i < 50; i++) {
        const { messages, state: newState } = await callSync({
          destSchema: schema,
          state,
          stateCheckpointLimit: 20,
        })
        state = newState
        allMessages.push(...messages)

        const states = messages.filter((m) => m.type === 'state')
        if (states.length === 0) break
      }

      const errors = allMessages.filter((m) => m.type === 'error')
      expect(errors, 'clean sync must produce zero errors').toHaveLength(0)

      const ids = await destIds(schema)
      const expectedIds = Array.from(
        { length: OBJECT_COUNT },
        (_, i) => `cus_e2e_${String(i).padStart(5, '0')}`
      )
      const missing = expectedIds.filter((id) => !ids.has(id))
      expect(missing, `missing objects: ${missing.slice(0, 5).join(', ')}`).toHaveLength(0)
      expect(ids.size).toBe(OBJECT_COUNT)
    },
    5 * 60_000
  )

  // -------------------------------------------------------------------------
  // 2. Source 500 errors → no data written
  // -------------------------------------------------------------------------

  it(
    'source 500 errors result in zero records written',
    async () => {
      const schema = nextSchema()
      faultProxy.setFaults({ errorRate: 1.0, errorCodes: [500] })
      faultProxy.resetCount()

      const { messages } = await callSync({ destSchema: schema })

      expect(faultProxy.injectedCount, 'fault proxy must inject requests').toBeGreaterThan(0)

      const count = await destRowCount(schema)
      expect(count, 'no data should be written when source fails completely').toBe(0)

      const records = messages.filter((m) => m.type === 'record')
      expect(records, 'no records should appear in output').toHaveLength(0)
    },
    2 * 60_000
  )

  // -------------------------------------------------------------------------
  // 3. Source 429 errors → no data written
  // -------------------------------------------------------------------------

  it(
    'source 429 errors result in zero records written',
    async () => {
      const schema = nextSchema()
      faultProxy.setFaults({ errorRate: 1.0, errorCodes: [429] })
      faultProxy.resetCount()

      const { messages } = await callSync({ destSchema: schema })

      expect(faultProxy.injectedCount, 'fault proxy must inject requests').toBeGreaterThan(0)

      const count = await destRowCount(schema)
      expect(count, 'no data should be written under 100% rate limits').toBe(0)

      const records = messages.filter((m) => m.type === 'record')
      expect(records, 'no records should appear in output').toHaveLength(0)
    },
    2 * 60_000
  )

  // -------------------------------------------------------------------------
  // 4. Paused destination → transient_error from destination
  // -------------------------------------------------------------------------

  it(
    'paused destination container produces error or timeout',
    async () => {
      const schema = nextSchema()
      faultProxy.setFaults({ errorRate: 0 })

      dockerPause(destDocker.containerId)
      let messages: NdjsonMessage[] = []
      try {
        const result = await callSync({ destSchema: schema, timeoutMs: 15_000 })
        messages = result.messages
      } catch {
        // Expected: fetch aborted because the destination DB is unresponsive
      } finally {
        dockerUnpause(destDocker.containerId)
        await waitForPg(destDocker.connectionString)
      }

      const errors = messages.filter((m) => m.type === 'error')
      if (errors.length > 0) {
        for (const err of errors) {
          expect(err.failure_type).toBe('transient_error')
        }
      }
    },
    2 * 60_000
  )

  // -------------------------------------------------------------------------
  // 5. Partial progress survives failures — state is resumable
  // -------------------------------------------------------------------------

  it(
    'state from a partial sync is resumable after failure',
    async () => {
      const schema = nextSchema()
      faultProxy.setFaults({ errorRate: 0 })

      // Step 1: run a partial sync (5 checkpoints only)
      const partial = await callSync({
        destSchema: schema,
        stateCheckpointLimit: 5,
      })
      const partialStates = partial.messages.filter((m) => m.type === 'state')
      const partialErrors = partial.messages.filter((m) => m.type === 'error')
      expect(partialErrors, 'partial sync must have zero errors').toHaveLength(0)
      expect(partialStates.length).toBeGreaterThan(0)
      expect(partialStates.length).toBeLessThanOrEqual(5)

      const countAfterPartial = await destRowCount(schema)
      expect(
        countAfterPartial,
        'partial sync should write some but not all objects'
      ).toBeGreaterThan(0)
      expect(countAfterPartial).toBeLessThan(OBJECT_COUNT)
      console.log(`    After partial sync: ${countAfterPartial} rows`)

      // Step 2: inject 100% 500 errors — no new records should be written
      faultProxy.setFaults({ errorRate: 1.0, errorCodes: [500] })
      faultProxy.resetCount()
      await callSync({
        destSchema: schema,
        state: partial.state,
      })
      expect(faultProxy.injectedCount, 'fault proxy must inject during step 2').toBeGreaterThan(0)
      const countAfterFailure = await destRowCount(schema)
      expect(
        countAfterFailure,
        'failure step must not write beyond partial count'
      ).toBeLessThanOrEqual(countAfterPartial)
      console.log(`    After failure step: ${countAfterFailure} rows (unchanged)`)

      // Step 3: the state from the partial sync should still be valid.
      // Resume with no faults and complete the sync.
      faultProxy.setFaults({ errorRate: 0 })

      let state = partial.state
      const resumeMessages: NdjsonMessage[] = []
      for (let i = 0; i < 50; i++) {
        const { messages, state: newState } = await callSync({
          destSchema: schema,
          state,
          stateCheckpointLimit: 20,
        })
        state = newState
        resumeMessages.push(...messages)

        const states = messages.filter((m) => m.type === 'state')
        if (states.length === 0) break
      }

      const resumeErrors = resumeMessages.filter((m) => m.type === 'error')
      expect(resumeErrors, 'resumed clean sync must have zero errors').toHaveLength(0)

      const ids = await destIds(schema)
      const expectedIds = Array.from(
        { length: OBJECT_COUNT },
        (_, i) => `cus_e2e_${String(i).padStart(5, '0')}`
      )
      const missing = expectedIds.filter((id) => !ids.has(id))
      expect(missing, `missing after resume: ${missing.slice(0, 5).join(', ')}`).toHaveLength(0)
      expect(ids.size).toBe(OBJECT_COUNT)
      console.log(`    After resume: ${ids.size} rows (complete)`)
    },
    5 * 60_000
  )

  // -------------------------------------------------------------------------
  // 6. State survives destination failure and sync completes on retry
  // -------------------------------------------------------------------------

  it(
    'sync completes after destination recovers from pause',
    async () => {
      const schema = nextSchema()
      faultProxy.setFaults({ errorRate: 0 })

      // Step 1: run a partial sync to get some data in
      const partial = await callSync({
        destSchema: schema,
        stateCheckpointLimit: 5,
      })
      const partialErrors = partial.messages.filter((m) => m.type === 'error')
      expect(partialErrors, 'partial sync must have zero errors').toHaveLength(0)

      const countBefore = await destRowCount(schema)
      expect(countBefore).toBeGreaterThan(0)
      console.log(`    Before pause: ${countBefore} rows`)

      // Step 2: pause the destination — the sync should fail or hang
      dockerPause(destDocker.containerId)
      let pauseErrorCount = 0
      try {
        const failed = await callSync({
          destSchema: schema,
          state: partial.state,
          timeoutMs: 15_000,
        })
        pauseErrorCount = failed.messages.filter((m) => m.type === 'error').length
      } catch {
        // Expected: fetch aborted because the destination DB is unresponsive
      } finally {
        dockerUnpause(destDocker.containerId)
        await waitForPg(destDocker.connectionString)
      }
      console.log(`    During pause: ${pauseErrorCount} error(s) or timed out`)

      // Step 3: the data from step 1 must still be there (not corrupted by the failure)
      const countAfterResume = await destRowCount(schema)
      expect(
        countAfterResume,
        'data written before pause must survive the failure'
      ).toBeGreaterThanOrEqual(countBefore)
      console.log(`    After unpause: ${countAfterResume} rows (>= ${countBefore})`)

      // Step 4: complete the sync from the partial state
      let state = partial.state
      const finishMessages: NdjsonMessage[] = []
      for (let i = 0; i < 50; i++) {
        const { messages, state: newState } = await callSync({
          destSchema: schema,
          state,
          stateCheckpointLimit: 20,
        })
        state = newState
        finishMessages.push(...messages)

        const states = messages.filter((m) => m.type === 'state')
        if (states.length === 0) break
      }

      const finishErrors = finishMessages.filter((m) => m.type === 'error')
      expect(finishErrors, 'post-recovery sync must have zero errors').toHaveLength(0)

      const ids = await destIds(schema)
      const expectedIds = Array.from(
        { length: OBJECT_COUNT },
        (_, i) => `cus_e2e_${String(i).padStart(5, '0')}`
      )
      const missing = expectedIds.filter((id) => !ids.has(id))
      expect(missing, `missing after recovery: ${missing.slice(0, 5).join(', ')}`).toHaveLength(0)
      expect(ids.size).toBe(OBJECT_COUNT)
      console.log(`    Final: ${ids.size} rows (complete)`)
    },
    5 * 60_000
  )
})
