import { afterAll, beforeAll, describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import pg from 'pg'
import {
  startDockerPostgres18,
  createStripeListServer,
  ensureSchema,
  ensureObjectTable,
  upsertObjects,
  type DockerPostgres18Handle,
  type StripeListServer,
} from '@stripe/sync-test-utils'
import { createEngine, readonlyStateStore } from '@stripe/sync-engine'
import sourceStripe, {
  type StripeStreamState,
  type BackfillState,
} from '@stripe/sync-source-stripe'
import destinationPostgres from '@stripe/sync-destination-postgres'
import type { PipelineConfig } from '@stripe/sync-engine'
import type { DestinationOutput } from '@stripe/sync-protocol'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const STRIPE_MOCK_URL = 'http://localhost:12111'

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let sourceDocker: DockerPostgres18Handle
let destDocker: DockerPostgres18Handle
let testServer: StripeListServer
let sourcePool: pg.Pool
let destPool: pg.Pool
let customerTemplate: Record<string, unknown>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

async function fetchCustomerTemplate(): Promise<Record<string, unknown>> {
  const res = await fetch(`${STRIPE_MOCK_URL}/v1/customers`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer sk_test_fake',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  })
  if (!res.ok) throw new Error(`stripe-mock POST /v1/customers failed: ${res.status}`)
  return (await res.json()) as Record<string, unknown>
}

function makeCustomer(id: string, created: number): Record<string, unknown> {
  return { ...customerTemplate, id, created }
}

async function restartTestServer(
  opts: { accountCreated?: number } = {}
): Promise<StripeListServer> {
  if (testServer) await testServer.close().catch(() => {})
  testServer = await createStripeListServer({
    postgresUrl: sourceDocker.connectionString,
    accountCreated: opts.accountCreated,
  })
  return testServer
}

type SyncResult = {
  messages: DestinationOutput[]
  state: Record<string, unknown>
}

async function runSync(opts: {
  streams?: PipelineConfig['streams']
  sourceOverrides?: Record<string, unknown>
  destSchema: string
  state?: Record<string, StripeStreamState>
}): Promise<SyncResult> {
  const pipeline: PipelineConfig = {
    source: {
      type: 'stripe',
      api_key: 'sk_test_fake',
      api_version: '2025-04-30.basil',
      base_url: testServer.url,
      rate_limit: 10_000,
      ...opts.sourceOverrides,
    },
    destination: {
      type: 'postgres',
      connection_string: destDocker.connectionString,
      schema: opts.destSchema,
      batch_size: 100,
    },
    streams: opts.streams ?? [{ name: 'customers', sync_mode: 'full_refresh' }],
  }

  const engine = createEngine(
    pipeline,
    { source: sourceStripe, destination: destinationPostgres },
    readonlyStateStore(opts.state)
  )

  const messages: DestinationOutput[] = []
  const state: Record<string, unknown> = { ...opts.state }
  for await (const msg of engine.sync()) {
    messages.push(msg)
    if (msg.type === 'state') {
      state[msg.stream] = msg.data
    }
  }
  return { messages, state }
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

describe('test-server sync', () => {
  beforeAll(async () => {
    await ensureStripeMock()
    ;[sourceDocker, destDocker, customerTemplate] = await Promise.all([
      startDockerPostgres18(),
      startDockerPostgres18(),
      fetchCustomerTemplate(),
    ])

    sourcePool = new pg.Pool({ connectionString: sourceDocker.connectionString })
    destPool = new pg.Pool({ connectionString: destDocker.connectionString })

    await ensureSchema(sourcePool, 'stripe')
    await ensureObjectTable(sourcePool, 'stripe', 'customers')

    console.log(`  Source PG:  ${sourceDocker.connectionString}`)
    console.log(`  Dest PG:    ${destDocker.connectionString}`)
  }, 5 * 60_000)

  afterAll(async () => {
    await testServer?.close().catch(() => {})
    await sourcePool?.end().catch(() => {})
    await destPool?.end().catch(() => {})
    destDocker?.stop()
    sourceDocker?.stop()
  }, 60_000)

  // ---------------------------------------------------------------------------
  // Boundary test
  // ---------------------------------------------------------------------------

  it('created filter boundaries: objects at segment edges are not lost or duplicated', async () => {
    const CONCURRENCY = 5
    const destSchema = `boundary_${Date.now()}`
    const RANGE_GTE = 1617408000 // 2021-04-03T00:00:00Z
    const RANGE_LT = 1775260800 // 2026-04-02T00:00:00Z (fixed, no timing dependency)

    // Step 1 — Define segments deterministically. We construct the exact
    // backfill state the engine uses, so expandState() produces segments
    // with our precise boundaries. Same production code path as X-State.
    const segmentSize = Math.max(1, Math.ceil((RANGE_LT - RANGE_GTE) / CONCURRENCY))

    const segments: Array<{ gte: number; lt: number }> = []
    for (let i = 0; i < CONCURRENCY; i++) {
      const gte = RANGE_GTE + i * segmentSize
      const lt = Math.min(RANGE_GTE + (i + 1) * segmentSize, RANGE_LT)
      if (gte >= RANGE_LT) break
      segments.push({ gte, lt })
    }

    const internalBoundaries = segments.slice(0, -1).map((s) => s.lt)
    console.log(`  Range: [${RANGE_GTE}, ${RANGE_LT}), ${CONCURRENCY} segments`)
    console.log(`  Segment size: ${segmentSize}s (~${(segmentSize / 86400).toFixed(0)} days)`)
    console.log(`  Internal boundaries: ${internalBoundaries.join(', ')}`)

    const backfillState: BackfillState = {
      range: { gte: RANGE_GTE, lt: RANGE_LT },
      numSegments: CONCURRENCY,
      completed: [],
      inFlight: [],
    }

    // Step 2 — Insert customers at exact boundary timestamps.
    // At each boundary B, segment[i] uses created[lt]=B (exclusive) and
    // segment[i+1] uses created[gte]=B (inclusive). A customer with created=B
    // must land in segment[i+1], not segment[i], and must not be lost.
    const boundaryCustomers = internalBoundaries.flatMap((b, i) => [
      makeCustomer(`cus_b${i}_at`, b),
      makeCustomer(`cus_b${i}_minus1`, b - 1),
      makeCustomer(`cus_b${i}_plus1`, b + 1),
    ])

    const edgeCustomers = [
      makeCustomer('cus_range_start', RANGE_GTE),
      makeCustomer('cus_range_start_p1', RANGE_GTE + 1),
      makeCustomer('cus_range_end_m1', RANGE_LT - 1),
    ]

    const allExpected = [...boundaryCustomers, ...edgeCustomers]

    await sourcePool.query(`DELETE FROM stripe.customers`)
    await upsertObjects(sourcePool, 'stripe', 'customers', allExpected)
    await restartTestServer()

    // Step 3 — Single sync with pre-built state. The engine sees the
    // backfill state and calls expandState() to reconstruct segments
    // using our exact range/numSegments — no timing ambiguity.
    const { messages } = await runSync({
      destSchema,
      sourceOverrides: { backfill_concurrency: CONCURRENCY },
      state: {
        customers: {
          pageCursor: null,
          status: 'pending',
          backfill: backfillState,
        },
      },
    })

    // Verify every customer arrived
    const { rows: idRows } = await destPool.query(
      `SELECT id FROM "${destSchema}"."customers" ORDER BY id`
    )
    const destIds = new Set(idRows.map((r: { id: string }) => r.id))

    for (const c of allExpected) {
      expect(destIds.has(c.id as string), `missing ${c.id} (created=${c.created})`).toBe(true)
    }

    // Verify no duplicates — row count must equal expected count
    expect(idRows.length).toBe(allExpected.length)

    // Verify the engine used our exact segments
    const stateMessages = messages.filter((m) => m.type === 'state')
    const lastState = stateMessages[stateMessages.length - 1] as {
      data: { backfill?: { range: { gte: number; lt: number }; numSegments: number } }
    }
    expect(lastState.data.backfill!.range).toEqual({ gte: RANGE_GTE, lt: RANGE_LT })
    expect(lastState.data.backfill!.numSegments).toBe(CONCURRENCY)

    console.log(
      `  Synced ${idRows.length}/${allExpected.length} customers (${internalBoundaries.length} boundaries tested)`
    )

    await destPool.query(`DROP SCHEMA IF EXISTS "${destSchema}" CASCADE`)
  }, 120_000)

  // ---------------------------------------------------------------------------
  // Additional test conditions
  // ---------------------------------------------------------------------------

  function computeSegments(gte: number, lt: number, n: number) {
    const size = Math.max(1, Math.ceil((lt - gte) / n))
    const segs: Array<{ gte: number; lt: number }> = []
    for (let i = 0; i < n; i++) {
      const sGte = gte + i * size
      const sLt = Math.min(gte + (i + 1) * size, lt)
      if (sGte >= lt) break
      segs.push({ gte: sGte, lt: sLt })
    }
    return segs
  }

  function mkBackfill(overrides?: Partial<BackfillState>): BackfillState {
    return {
      range: { gte: 1617408000, lt: 1775260800 },
      numSegments: 5,
      completed: [],
      inFlight: [],
      ...overrides,
    }
  }

  async function seedCustomers(
    objects: Record<string, unknown>[],
    opts: { accountCreated?: number } = {}
  ) {
    await sourcePool.query('DELETE FROM stripe.customers')
    if (objects.length > 0) {
      await upsertObjects(sourcePool, 'stripe', 'customers', objects)
    }
    await restartTestServer(opts)
  }

  // ---------------------------------------------------------------------------
  // 1. Out-of-range exclusion
  // ---------------------------------------------------------------------------

  it('out-of-range objects are excluded by created filter', async () => {
    const destSchema = `outofrange_${Date.now()}`
    const GTE = 1617408000
    const LT = 1775260800

    const inRange = [
      makeCustomer('cus_in_start', GTE),
      makeCustomer('cus_in_mid', GTE + 1000),
      makeCustomer('cus_in_end_m1', LT - 1),
    ]
    const outOfRange = [
      makeCustomer('cus_out_before_far', GTE - 100),
      makeCustomer('cus_out_before_1', GTE - 1),
      makeCustomer('cus_out_at_end', LT),
      makeCustomer('cus_out_after_far', LT + 100),
    ]

    await seedCustomers([...inRange, ...outOfRange])

    await runSync({
      destSchema,
      sourceOverrides: { backfill_concurrency: 1 },
      state: {
        customers: {
          pageCursor: null,
          status: 'pending',
          backfill: mkBackfill({ numSegments: 1 }),
        },
      },
    })

    const { rows } = await destPool.query(`SELECT id FROM "${destSchema}"."customers" ORDER BY id`)
    const ids = new Set(rows.map((r: { id: string }) => r.id))

    for (const c of inRange) {
      expect(ids.has(c.id as string), `expected in-range ${c.id}`).toBe(true)
    }
    for (const c of outOfRange) {
      expect(ids.has(c.id as string), `unexpected out-of-range ${c.id}`).toBe(false)
    }
    expect(rows.length).toBe(inRange.length)

    await destPool.query(`DROP SCHEMA IF EXISTS "${destSchema}" CASCADE`)
  }, 120_000)

  // ---------------------------------------------------------------------------
  // 2. Multi-page pagination within a segment
  // ---------------------------------------------------------------------------

  it('multi-page: >100 objects in a segment forces pagination', async () => {
    const destSchema = `multipage_${Date.now()}`
    const GTE = 1617408000
    const COUNT = 120

    const objects = Array.from({ length: COUNT }, (_, i) =>
      makeCustomer(`cus_mp_${String(i).padStart(3, '0')}`, GTE + i * 100)
    )

    await seedCustomers(objects)

    const { messages } = await runSync({
      destSchema,
      sourceOverrides: { backfill_concurrency: 1 },
      state: {
        customers: {
          pageCursor: null,
          status: 'pending',
          backfill: mkBackfill({ numSegments: 1 }),
        },
      },
    })

    const { rows } = await destPool.query(`SELECT id FROM "${destSchema}"."customers"`)
    expect(rows.length).toBe(COUNT)

    const stateMessages = messages.filter((m) => m.type === 'state')
    expect(
      stateMessages.length,
      'pagination must produce >1 state checkpoint (one per page)'
    ).toBeGreaterThan(1)

    await destPool.query(`DROP SCHEMA IF EXISTS "${destSchema}" CASCADE`)
  }, 120_000)

  // ---------------------------------------------------------------------------
  // 3. Duplicate emission detection
  // ---------------------------------------------------------------------------

  it('no duplicate record IDs emitted by source across segments', async () => {
    const destSchema = `dupcheck_${Date.now()}`
    const GTE = 1617408000
    const LT = 1775260800
    const CONC = 5
    const segs = computeSegments(GTE, LT, CONC)
    const boundaries = segs.slice(0, -1).map((s) => s.lt)

    const objects = boundaries.flatMap((b, i) => [
      makeCustomer(`cus_d${i}_at`, b),
      makeCustomer(`cus_d${i}_m1`, b - 1),
      makeCustomer(`cus_d${i}_p1`, b + 1),
    ])
    objects.push(makeCustomer('cus_d_start', GTE))
    objects.push(makeCustomer('cus_d_end_m1', LT - 1))

    await seedCustomers(objects)

    const pipeline: PipelineConfig = {
      source: {
        type: 'stripe',
        api_key: 'sk_test_fake',
        api_version: '2025-04-30.basil',
        base_url: testServer.url,
        rate_limit: 10_000,
        backfill_concurrency: CONC,
      },
      destination: {
        type: 'postgres',
        connection_string: destDocker.connectionString,
        schema: destSchema,
        batch_size: 100,
      },
      streams: [{ name: 'customers', sync_mode: 'full_refresh' as const }],
    }

    const engine = createEngine(
      pipeline,
      { source: sourceStripe, destination: destinationPostgres },
      readonlyStateStore({
        customers: {
          pageCursor: null,
          status: 'pending',
          backfill: mkBackfill({ numSegments: CONC }),
        },
      })
    )

    const recordIds: string[] = []
    for await (const msg of engine.read()) {
      const m = msg as { type: string; data?: { id?: string } }
      if (m.type === 'record') {
        recordIds.push(m.data!.id!)
      }
    }

    const uniqueIds = new Set(recordIds)
    expect(recordIds.length, 'source emitted duplicate record IDs').toBe(uniqueIds.size)
    expect(recordIds.length).toBe(objects.length)
  }, 120_000)

  // ---------------------------------------------------------------------------
  // 4. Resume from partially-completed state
  // ---------------------------------------------------------------------------

  it('resume from partially-completed state skips completed segments', async () => {
    const destSchema = `resume_${Date.now()}`
    const GTE = 1617408000
    const LT = 1775260800
    const CONC = 5
    const segs = computeSegments(GTE, LT, CONC)

    const allObjects = segs.flatMap((seg, i) => [
      makeCustomer(`cus_seg${i}_a`, seg.gte + 100),
      makeCustomer(`cus_seg${i}_b`, seg.gte + 200),
    ])

    await seedCustomers(allObjects)

    const backfill = mkBackfill({
      numSegments: CONC,
      completed: [{ gte: segs[0].gte, lt: segs[2].lt }],
    })

    await runSync({
      destSchema,
      sourceOverrides: { backfill_concurrency: CONC },
      state: {
        customers: { pageCursor: null, status: 'pending', backfill },
      },
    })

    const { rows } = await destPool.query(`SELECT id FROM "${destSchema}"."customers" ORDER BY id`)
    const destIds = new Set(rows.map((r: { id: string }) => r.id))

    for (const i of [3, 4]) {
      expect(destIds.has(`cus_seg${i}_a`), `missing cus_seg${i}_a`).toBe(true)
      expect(destIds.has(`cus_seg${i}_b`), `missing cus_seg${i}_b`).toBe(true)
    }
    for (const i of [0, 1, 2]) {
      expect(destIds.has(`cus_seg${i}_a`), `unexpected cus_seg${i}_a`).toBe(false)
      expect(destIds.has(`cus_seg${i}_b`), `unexpected cus_seg${i}_b`).toBe(false)
    }
    expect(rows.length).toBe(4)

    await destPool.query(`DROP SCHEMA IF EXISTS "${destSchema}" CASCADE`)
  }, 120_000)

  // ---------------------------------------------------------------------------
  // 5. Empty segments
  // ---------------------------------------------------------------------------

  it('empty segments complete without hanging', async () => {
    const destSchema = `empty_${Date.now()}`
    const GTE = 1617408000
    const LT = 1775260800
    const CONC = 5
    const segs = computeSegments(GTE, LT, CONC)

    const objects = [0, 2, 4].map((i) => makeCustomer(`cus_e${i}`, segs[i].gte + 100))

    await seedCustomers(objects)

    const { state } = await runSync({
      destSchema,
      sourceOverrides: { backfill_concurrency: CONC },
      state: {
        customers: {
          pageCursor: null,
          status: 'pending',
          backfill: mkBackfill({ numSegments: CONC }),
        },
      },
    })

    const { rows } = await destPool.query(`SELECT id FROM "${destSchema}"."customers"`)
    expect(rows.length).toBe(objects.length)

    const finalState = state.customers as StripeStreamState
    expect(finalState.status).toBe('complete')

    await destPool.query(`DROP SCHEMA IF EXISTS "${destSchema}" CASCADE`)
  }, 120_000)

  // ---------------------------------------------------------------------------
  // 6. Second sync after completion (idempotent re-run)
  // ---------------------------------------------------------------------------

  it('second sync after completion emits zero records', async () => {
    const destSchema = `idempotent_${Date.now()}`
    const GTE = 1617408000
    const LT = 1775260800

    const objects = [makeCustomer('cus_idem_1', GTE + 100)]
    await seedCustomers(objects)

    const completedState: Record<string, StripeStreamState> = {
      customers: {
        pageCursor: null,
        status: 'complete',
        backfill: {
          range: { gte: GTE, lt: LT },
          numSegments: 5,
          completed: [{ gte: GTE, lt: LT }],
          inFlight: [],
        },
      },
    }

    const { messages } = await runSync({
      destSchema,
      state: completedState,
    })

    const custStates = messages.filter(
      (m) => m.type === 'state' && (m as { stream: string }).stream === 'customers'
    )
    expect(custStates.length).toBe(0)

    const { rows } = await destPool.query(
      `SELECT count(*)::int AS c FROM "${destSchema}"."customers"`
    )
    expect(rows[0].c).toBe(0)

    await destPool.query(`DROP SCHEMA IF EXISTS "${destSchema}" CASCADE`)
  }, 120_000)

  // ---------------------------------------------------------------------------
  // 7. backfill_limit caps records fetched
  // ---------------------------------------------------------------------------

  it('backfill_limit stops fetching after the threshold', async () => {
    const destSchema = `bflimit_${Date.now()}`
    const GTE = 1617408000
    const TOTAL = 150

    const objects = Array.from({ length: TOTAL }, (_, i) =>
      makeCustomer(`cus_bl_${String(i).padStart(3, '0')}`, GTE + i * 100)
    )

    await seedCustomers(objects)

    const { messages } = await runSync({
      destSchema,
      sourceOverrides: { backfill_concurrency: 1 },
      streams: [{ name: 'customers', sync_mode: 'full_refresh', backfill_limit: 5 }],
      state: {
        customers: {
          pageCursor: null,
          status: 'pending',
          backfill: mkBackfill({ numSegments: 1 }),
        },
      },
    })

    const { rows } = await destPool.query(
      `SELECT count(*)::int AS c FROM "${destSchema}"."customers"`
    )
    const synced = rows[0].c as number

    expect(synced).toBeGreaterThan(0)
    expect(synced).toBeLessThan(TOTAL)

    const stateMessages = messages.filter(
      (m) => m.type === 'state' && (m as { stream: string }).stream === 'customers'
    )
    expect(stateMessages.length).toBeGreaterThan(0)

    console.log(`  backfill_limit: synced ${synced}/${TOTAL} records (limit=5, page_size=100)`)

    await destPool.query(`DROP SCHEMA IF EXISTS "${destSchema}" CASCADE`)
  }, 120_000)

  // ---------------------------------------------------------------------------
  // 8. ID lexicographic order vs created order mismatch
  // ---------------------------------------------------------------------------

  it('pagination handles ID/created order mismatch correctly', async () => {
    const destSchema = `idorder_${Date.now()}`
    const GTE = 1617408000
    const COUNT = 120

    // Cycle through 5 distinct created timestamps so many objects share the
    // same value. The secondary sort key (id DESC) determines order within a
    // group, exercising the (created, id) tuple comparison in pagination.
    const timestamps = Array.from({ length: 5 }, (_, i) => GTE + (i + 1) * 1000)
    const objects = Array.from({ length: COUNT }, (_, i) =>
      makeCustomer(`cus_tie_${String(i).padStart(3, '0')}`, timestamps[i % timestamps.length])
    )

    await seedCustomers(objects)

    await runSync({
      destSchema,
      sourceOverrides: { backfill_concurrency: 1 },
      state: {
        customers: {
          pageCursor: null,
          status: 'pending',
          backfill: mkBackfill({ numSegments: 1 }),
        },
      },
    })

    const { rows } = await destPool.query(
      `SELECT count(*)::int AS c FROM "${destSchema}"."customers"`
    )
    expect(rows[0].c).toBe(COUNT)

    await destPool.query(`DROP SCHEMA IF EXISTS "${destSchema}" CASCADE`)
  }, 120_000)
})
