import { afterAll, beforeAll, describe, it, expect } from 'vitest'
import { execSync } from 'node:child_process'
import pg from 'pg'
import {
  startDockerPostgres18,
  createStripeListServer,
  ensureObjectTable,
  upsertObjects,
  applyCreatedTimestampRange,
  type DockerPostgres18Handle,
  type StripeListServer,
} from '@stripe/sync-test-utils'
import { createEngine, readonlyStateStore, type PipelineConfig } from '@stripe/sync-engine'
import sourceStripe, {
  expandState,
  type StripeStreamState,
  type BackfillState,
} from '@stripe/sync-source-stripe'
import destinationPostgres from '@stripe/sync-destination-postgres'
import type { DestinationOutput } from '@stripe/sync-protocol'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const STRIPE_MOCK_URL = 'http://localhost:12111'

/** Convert a UTC date string to a Unix timestamp in seconds. */
function utc(date: string): number {
  return Math.floor(new Date(date + 'T00:00:00Z').getTime() / 1000)
}

const RANGE_START = utc('2021-04-03')
const RANGE_END = utc('2026-04-02')

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let sourceDocker: DockerPostgres18Handle
let destDocker: DockerPostgres18Handle
let testServer: StripeListServer
let sourcePool: pg.Pool
let destPool: pg.Pool
let customerTemplate: Record<string, unknown>
let productTemplate: Record<string, unknown>

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

async function fetchObjectTemplate(
  endpoint: string,
  body?: string
): Promise<Record<string, unknown>> {
  const res = await fetch(`${STRIPE_MOCK_URL}${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer sk_test_fake',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    ...(body != null ? { body } : {}),
  })
  if (!res.ok) throw new Error(`stripe-mock POST ${endpoint} failed: ${res.status}`)
  return (await res.json()) as Record<string, unknown>
}

function makeCustomer(id: string, created: number): Record<string, unknown> {
  return { ...customerTemplate, id, created }
}

function makeProduct(id: string, created: number): Record<string, unknown> {
  return { ...productTemplate, id, created }
}

async function restartTestServer(
  opts: { accountCreated?: number } = {}
): Promise<StripeListServer> {
  if (testServer) await testServer.close().catch(() => {})
  testServer = await createStripeListServer({
    postgresUrl: sourceDocker.connectionString,
    accountCreated: opts.accountCreated ?? RANGE_START,
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
  const createdSchemas: string[] = []

  function uniqueSchema(prefix: string): string {
    const name = `${prefix}_${Date.now()}`
    createdSchemas.push(name)
    return name
  }

  beforeAll(async () => {
    await ensureStripeMock()
    ;[sourceDocker, destDocker, customerTemplate, productTemplate] = await Promise.all([
      startDockerPostgres18(),
      startDockerPostgres18(),
      fetchObjectTemplate('/v1/customers'),
      fetchObjectTemplate('/v1/products', 'name=Test+Product'),
    ])

    sourcePool = new pg.Pool({ connectionString: sourceDocker.connectionString })
    destPool = new pg.Pool({ connectionString: destDocker.connectionString })

    // Start test server first — it creates the schema via ensureSchema
    testServer = await createStripeListServer({
      postgresUrl: sourceDocker.connectionString,
      accountCreated: RANGE_START,
    })

    await Promise.all([
      ensureObjectTable(sourcePool, 'stripe', 'customers'),
      ensureObjectTable(sourcePool, 'stripe', 'products'),
    ])

    console.log(`  Source PG:  ${sourceDocker.connectionString}`)
    console.log(`  Dest PG:    ${destDocker.connectionString}`)
  }, 5 * 60_000)

  afterAll(async () => {
    for (const schema of createdSchemas) {
      await destPool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {})
    }
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
    const CONC = 5
    const destSchema = uniqueSchema('boundary')
    const segments = expandState(mkBackfill({ numSegments: CONC }))
    const internalBoundaries = segments.slice(0, -1).map((s) => s.lt)

    // At each boundary B, segment[i] uses created[lt]=B (exclusive) and
    // segment[i+1] uses created[gte]=B (inclusive). A customer with created=B
    // must land in segment[i+1], not segment[i], and must not be lost.
    const boundaryCustomers = internalBoundaries.flatMap((b, i) => [
      makeCustomer(`cus_b${i}_at`, b),
      makeCustomer(`cus_b${i}_minus1`, b - 1),
      makeCustomer(`cus_b${i}_plus1`, b + 1),
    ])

    const edgeCustomers = [
      makeCustomer('cus_range_start', RANGE_START),
      makeCustomer('cus_range_start_p1', RANGE_START + 1),
      makeCustomer('cus_range_end_m1', RANGE_END - 1),
    ]

    const boundaryAndEdge = [...boundaryCustomers, ...edgeCustomers]
    const fillers = generateCustomers(10_000 - boundaryAndEdge.length, 'cus_bfill_')
    const allExpected = [...boundaryAndEdge, ...fillers]

    await seedCustomers(allExpected)

    const { messages } = await runSync({
      destSchema,
      sourceOverrides: { backfill_concurrency: CONC },
      state: { customers: pendingState({ numSegments: CONC }) },
    })

    const { rows: idRows } = await destPool.query(
      `SELECT id FROM "${destSchema}"."customers" ORDER BY id`
    )
    const destIds = new Set(idRows.map((r: { id: string }) => r.id))

    for (const c of allExpected) {
      expect(destIds.has(c.id as string), `missing ${c.id} (created=${c.created})`).toBe(true)
    }
    expect(idRows.length).toBe(allExpected.length)

    const stateMessages = messages.filter((m) => m.type === 'state')
    const lastState = stateMessages[stateMessages.length - 1] as {
      data: { backfill?: { range: { gte: number; lt: number }; numSegments: number } }
    }
    expect(lastState.data.backfill!.range).toEqual({ gte: RANGE_START, lt: RANGE_END })
    expect(lastState.data.backfill!.numSegments).toBe(CONC)

    console.log(
      `  Synced ${idRows.length}/${allExpected.length} customers (${internalBoundaries.length} boundaries tested)`
    )
  }, 120_000)

  // ---------------------------------------------------------------------------
  // Additional test conditions
  // ---------------------------------------------------------------------------

  function mkBackfill(overrides?: Partial<BackfillState>): BackfillState {
    return {
      range: { gte: RANGE_START, lt: RANGE_END },
      numSegments: 5,
      completed: [],
      inFlight: [],
      ...overrides,
    }
  }

  function pendingState(overrides?: Partial<BackfillState>): StripeStreamState {
    return { pageCursor: null, status: 'pending', backfill: mkBackfill(overrides) }
  }

  const SEED_BATCH = 1000

  async function batchUpsert(table: string, objects: Record<string, unknown>[]) {
    for (let i = 0; i < objects.length; i += SEED_BATCH) {
      await upsertObjects(sourcePool, 'stripe', table, objects.slice(i, i + SEED_BATCH))
    }
  }

  function generateCustomers(count: number, prefix: string): Record<string, unknown>[] {
    const shells = Array.from({ length: count }, (_, i) =>
      makeCustomer(`${prefix}${String(i).padStart(5, '0')}`, 0)
    )
    return applyCreatedTimestampRange(shells, { startUnix: RANGE_START, endUnix: RANGE_END })
  }

  async function seedCustomers(
    objects: Record<string, unknown>[],
    opts: { accountCreated?: number } = {}
  ) {
    await sourcePool.query('DELETE FROM stripe.customers')
    if (objects.length > 0) {
      await batchUpsert('customers', objects)
    }
    await restartTestServer(opts)
  }

  // ---------------------------------------------------------------------------
  // 1. Out-of-range exclusion
  // ---------------------------------------------------------------------------

  it('out-of-range objects are excluded by created filter', async () => {
    const destSchema = uniqueSchema('outofrange')

    const namedInRange = [
      makeCustomer('cus_in_start', RANGE_START),
      makeCustomer('cus_in_mid', RANGE_START + 1000),
      makeCustomer('cus_in_end_m1', RANGE_END - 1),
    ]
    const fillers = generateCustomers(10_000, 'cus_oor_')
    const inRange = [...namedInRange, ...fillers]
    const outOfRange = [
      makeCustomer('cus_out_before_far', RANGE_START - 100),
      makeCustomer('cus_out_before_1', RANGE_START - 1),
      makeCustomer('cus_out_at_end', RANGE_END),
      makeCustomer('cus_out_after_far', RANGE_END + 100),
    ]

    await seedCustomers([...inRange, ...outOfRange])

    await runSync({
      destSchema,
      sourceOverrides: { backfill_concurrency: 1 },
      state: { customers: pendingState({ numSegments: 1 }) },
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
  }, 120_000)

  // ---------------------------------------------------------------------------
  // 2. Multi-page pagination within a segment
  // ---------------------------------------------------------------------------

  it('multi-page: >100 objects in a segment forces pagination', async () => {
    const destSchema = uniqueSchema('multipage')
    const COUNT = 10_000

    const objects = generateCustomers(COUNT, 'cus_mp_')

    await seedCustomers(objects)

    const { messages } = await runSync({
      destSchema,
      sourceOverrides: { backfill_concurrency: 1 },
    })

    const { rows } = await destPool.query(`SELECT id FROM "${destSchema}"."customers"`)
    expect(rows.length).toBe(COUNT)

    const stateMessages = messages.filter((m) => m.type === 'state')
    expect(
      stateMessages.length,
      'pagination must produce >1 state checkpoint (one per page)'
    ).toBeGreaterThan(1)
  }, 120_000)

  // ---------------------------------------------------------------------------
  // 3. Duplicate emission detection
  // ---------------------------------------------------------------------------

  it('no duplicate record IDs emitted by source across segments', async () => {
    const destSchema = uniqueSchema('dupcheck')
    const CONC = 5
    const segs = expandState(mkBackfill({ numSegments: CONC }))
    const boundaries = segs.slice(0, -1).map((s) => s.lt)

    const boundaryObjs = boundaries.flatMap((b, i) => [
      makeCustomer(`cus_d${i}_at`, b),
      makeCustomer(`cus_d${i}_m1`, b - 1),
      makeCustomer(`cus_d${i}_p1`, b + 1),
    ])
    boundaryObjs.push(makeCustomer('cus_d_start', RANGE_START))
    boundaryObjs.push(makeCustomer('cus_d_end_m1', RANGE_END - 1))
    const fillers = generateCustomers(10_000 - boundaryObjs.length, 'cus_dfill_')
    const objects = [...boundaryObjs, ...fillers]

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
      readonlyStateStore({ customers: pendingState({ numSegments: CONC }) })
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
    const destSchema = uniqueSchema('resume')
    const CONC = 5
    const segs = expandState(mkBackfill({ numSegments: CONC }))

    const PER_SEG = 2000
    const allObjects = segs.flatMap((seg, segIdx) => {
      const step = Math.max(1, Math.floor((seg.lt - seg.gte - 2) / PER_SEG))
      return Array.from({ length: PER_SEG }, (_, i) =>
        makeCustomer(`cus_seg${segIdx}_${String(i).padStart(4, '0')}`, seg.gte + 1 + i * step)
      )
    })

    await seedCustomers(allObjects)

    const completedRange = { gte: segs[0].gte, lt: segs[2].lt }
    await runSync({
      destSchema,
      sourceOverrides: { backfill_concurrency: CONC },
      state: {
        customers: pendingState({
          numSegments: CONC,
          completed: [completedRange],
        }),
      },
    })

    const { rows } = await destPool.query(`SELECT id FROM "${destSchema}"."customers" ORDER BY id`)
    const destIds = new Set(rows.map((r: { id: string }) => r.id))

    for (const i of [3, 4]) {
      for (let j = 0; j < PER_SEG; j++) {
        const id = `cus_seg${i}_${String(j).padStart(4, '0')}`
        expect(destIds.has(id), `missing ${id}`).toBe(true)
      }
    }
    for (const i of [0, 1, 2]) {
      expect(destIds.has(`cus_seg${i}_0000`), `unexpected cus_seg${i}_0000`).toBe(false)
    }
    expect(rows.length).toBe(PER_SEG * 2)
  }, 120_000)

  // ---------------------------------------------------------------------------
  // 5. Empty segments
  // ---------------------------------------------------------------------------

  it('empty segments complete without hanging', async () => {
    const destSchema = uniqueSchema('empty')
    const CONC = 5
    const segs = expandState(mkBackfill({ numSegments: CONC }))

    const populatedSegs = [0, 2, 4]
    const perSeg = Math.ceil(10_000 / populatedSegs.length)
    const objects = populatedSegs.flatMap((segIdx) => {
      const seg = segs[segIdx]
      const step = Math.max(1, Math.floor((seg.lt - seg.gte - 2) / perSeg))
      return Array.from({ length: perSeg }, (_, i) =>
        makeCustomer(`cus_e${segIdx}_${String(i).padStart(4, '0')}`, seg.gte + 1 + i * step)
      )
    })

    await seedCustomers(objects)

    const { state } = await runSync({
      destSchema,
      sourceOverrides: { backfill_concurrency: CONC },
      state: { customers: pendingState({ numSegments: CONC }) },
    })

    const { rows } = await destPool.query(`SELECT id FROM "${destSchema}"."customers"`)
    expect(rows.length).toBe(objects.length)

    const finalState = state.customers as StripeStreamState
    expect(finalState.status).toBe('complete')
  }, 120_000)

  // ---------------------------------------------------------------------------
  // 6. Second sync after completion (idempotent re-run)
  // ---------------------------------------------------------------------------

  it('second sync after completion emits zero records', async () => {
    const destSchema = uniqueSchema('idempotent')

    await seedCustomers(generateCustomers(10_000, 'cus_idem_'))

    const completedState: Record<string, StripeStreamState> = {
      customers: {
        pageCursor: null,
        status: 'complete',
        backfill: {
          range: { gte: RANGE_START, lt: RANGE_END },
          numSegments: 5,
          completed: [{ gte: RANGE_START, lt: RANGE_END }],
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
  }, 120_000)

  // ---------------------------------------------------------------------------
  // 7. backfill_limit caps records fetched
  // ---------------------------------------------------------------------------

  it('backfill_limit stops fetching after the threshold', async () => {
    const destSchema = uniqueSchema('bflimit')
    const TOTAL = 10_000

    const objects = generateCustomers(TOTAL, 'cus_bl_')

    await seedCustomers(objects)

    const { messages } = await runSync({
      destSchema,
      sourceOverrides: { backfill_concurrency: 1 },
      streams: [{ name: 'customers', sync_mode: 'full_refresh', backfill_limit: 5 }],
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
  }, 120_000)

  // ---------------------------------------------------------------------------
  // 8. ID lexicographic order vs created order mismatch
  // ---------------------------------------------------------------------------

  it('pagination handles ID/created order mismatch correctly', async () => {
    const destSchema = uniqueSchema('idorder')
    const COUNT = 10_000

    // Cycle through 5 distinct created timestamps so many objects share the
    // same value. The secondary sort key (id DESC) determines order within a
    // group, exercising the (created, id) tuple comparison in pagination.
    const timestamps = Array.from({ length: 5 }, (_, i) => RANGE_START + (i + 1) * 1000)
    const objects = Array.from({ length: COUNT }, (_, i) =>
      makeCustomer(`cus_tie_${String(i).padStart(5, '0')}`, timestamps[i % timestamps.length])
    )

    await seedCustomers(objects)

    await runSync({
      destSchema,
      sourceOverrides: { backfill_concurrency: 1 },
    })

    const { rows } = await destPool.query(
      `SELECT count(*)::int AS c FROM "${destSchema}"."customers"`
    )
    expect(rows[0].c).toBe(COUNT)
  }, 120_000)

  // ---------------------------------------------------------------------------
  // 9. Multiple streams (customers + products)
  // ---------------------------------------------------------------------------

  it('syncs multiple streams in a single run', async () => {
    const destSchema = uniqueSchema('multistream')
    const PER_STREAM = 5000

    const range = { startUnix: RANGE_START, endUnix: RANGE_END }
    const customers = applyCreatedTimestampRange(
      Array.from({ length: PER_STREAM }, (_, i) =>
        makeCustomer(`cus_ms_${String(i).padStart(5, '0')}`, 0)
      ),
      range
    )
    const products = applyCreatedTimestampRange(
      Array.from({ length: PER_STREAM }, (_, i) =>
        makeProduct(`prod_ms_${String(i).padStart(5, '0')}`, 0)
      ),
      range
    )

    await sourcePool.query('DELETE FROM stripe.customers')
    await sourcePool.query('DELETE FROM stripe.products')
    await Promise.all([batchUpsert('customers', customers), batchUpsert('products', products)])
    await restartTestServer()

    const { state } = await runSync({
      destSchema,
      sourceOverrides: { backfill_concurrency: 1 },
      streams: [
        { name: 'customers', sync_mode: 'full_refresh' },
        { name: 'products', sync_mode: 'full_refresh' },
      ],
    })

    const { rows: custRows } = await destPool.query(
      `SELECT id FROM "${destSchema}"."customers" ORDER BY id`
    )
    const { rows: prodRows } = await destPool.query(
      `SELECT id FROM "${destSchema}"."products" ORDER BY id`
    )

    expect(custRows.length).toBe(customers.length)
    expect(prodRows.length).toBe(products.length)

    const custState = state.customers as StripeStreamState
    const prodState = state.products as StripeStreamState
    expect(custState.status).toBe('complete')
    expect(prodState.status).toBe('complete')
  }, 120_000)

  // ---------------------------------------------------------------------------
  // 10. Zero objects — completely empty source
  // ---------------------------------------------------------------------------

  it('zero objects: empty source completes cleanly with no records', async () => {
    const destSchema = uniqueSchema('zerobj')

    await seedCustomers([])

    const { state } = await runSync({
      destSchema,
      sourceOverrides: { backfill_concurrency: 1 },
    })

    const { rows } = await destPool.query(
      `SELECT count(*)::int AS c FROM "${destSchema}"."customers"`
    )
    expect(rows[0].c).toBe(0)

    const finalState = state.customers as StripeStreamState
    expect(finalState.status).toBe('complete')
  }, 120_000)

  // ---------------------------------------------------------------------------
  // 11. Single object edge case
  // ---------------------------------------------------------------------------

  it('single object: exactly one record syncs correctly', async () => {
    const destSchema = uniqueSchema('single')

    await seedCustomers([makeCustomer('cus_only_one', RANGE_START + 500)])

    const { state } = await runSync({
      destSchema,
      sourceOverrides: { backfill_concurrency: 1 },
    })

    const { rows } = await destPool.query(`SELECT id FROM "${destSchema}"."customers"`)
    expect(rows.length).toBe(1)
    expect(rows[0].id).toBe('cus_only_one')

    const finalState = state.customers as StripeStreamState
    expect(finalState.status).toBe('complete')
  }, 120_000)

  // ---------------------------------------------------------------------------
  // 12. Data integrity — round-trip fidelity
  // ---------------------------------------------------------------------------

  it('data integrity: destination _raw_data matches source objects', async () => {
    const destSchema = uniqueSchema('integrity')

    const sourceObjects = generateCustomers(10_000, 'cus_int_')

    await seedCustomers(sourceObjects)

    await runSync({
      destSchema,
      sourceOverrides: { backfill_concurrency: 1 },
    })

    const { rows: countRows } = await destPool.query(
      `SELECT count(*)::int AS c FROM "${destSchema}"."customers"`
    )
    expect(countRows[0].c).toBe(sourceObjects.length)

    const sample = [sourceObjects[0], sourceObjects[4999], sourceObjects[9999]]
    for (const src of sample) {
      const { rows } = await destPool.query(
        `SELECT "_raw_data" FROM "${destSchema}"."customers" WHERE id = $1`,
        [src.id]
      )
      expect(rows.length, `missing ${src.id} in destination`).toBe(1)
      const dest = rows[0]._raw_data as Record<string, unknown>
      expect(dest.id).toBe(src.id)
      expect(dest.created).toBe(src.created)
      expect(dest.object).toBe('customer')
      expect(dest.email).toBe(src.email)
    }
  }, 120_000)

  // ---------------------------------------------------------------------------
  // 13. Multi-page across multiple concurrent segments
  // ---------------------------------------------------------------------------

  it('multi-page pagination across multiple concurrent segments', async () => {
    const destSchema = uniqueSchema('multipageseg')
    const CONC = 3
    const segs = expandState(mkBackfill({ numSegments: CONC }))
    const PER_SEGMENT = 3334

    const objects = segs.flatMap((seg, segIdx) => {
      const step = Math.floor((seg.lt - seg.gte - 2) / PER_SEGMENT)
      return Array.from({ length: PER_SEGMENT }, (_, i) =>
        makeCustomer(`cus_mps${segIdx}_${String(i).padStart(4, '0')}`, seg.gte + 1 + i * step)
      )
    })

    await seedCustomers(objects)

    const { messages, state } = await runSync({
      destSchema,
      sourceOverrides: { backfill_concurrency: CONC },
      state: { customers: pendingState({ numSegments: CONC }) },
    })

    const { rows } = await destPool.query(
      `SELECT count(*)::int AS c FROM "${destSchema}"."customers"`
    )
    expect(rows[0].c).toBe(objects.length)

    const stateMessages = messages.filter(
      (m) => m.type === 'state' && (m as { stream: string }).stream === 'customers'
    )
    expect(
      stateMessages.length,
      'multi-segment pagination must produce multiple state checkpoints'
    ).toBeGreaterThan(CONC)

    const finalState = state.customers as StripeStreamState
    expect(finalState.status).toBe('complete')
  }, 120_000)

  // ---------------------------------------------------------------------------
  // 14. Test server: retrieve endpoint and error responses
  // ---------------------------------------------------------------------------

  it('test server: retrieve returns object by ID, 404 for missing', async () => {
    await seedCustomers([makeCustomer('cus_ret_1', RANGE_START + 100)])

    const okRes = await fetch(`${testServer.url}/v1/customers/cus_ret_1`, {
      headers: { Authorization: 'Bearer sk_test_fake' },
    })
    expect(okRes.status).toBe(200)
    const body = (await okRes.json()) as Record<string, unknown>
    expect(body.id).toBe('cus_ret_1')
    expect(body.object).toBe('customer')

    const notFoundRes = await fetch(`${testServer.url}/v1/customers/cus_nonexistent`, {
      headers: { Authorization: 'Bearer sk_test_fake' },
    })
    expect(notFoundRes.status).toBe(404)
    const errBody = (await notFoundRes.json()) as { error: { code: string } }
    expect(errBody.error.code).toBe('resource_missing')
  }, 120_000)

  it('test server: unrecognized path returns 404, non-GET returns 405', async () => {
    await seedCustomers([])

    const notFoundRes = await fetch(`${testServer.url}/v1/totally_fake_endpoint`, {
      headers: { Authorization: 'Bearer sk_test_fake' },
    })
    expect(notFoundRes.status).toBe(404)
    const errBody = (await notFoundRes.json()) as { error: { type: string } }
    expect(errBody.error.type).toBe('invalid_request_error')

    const methodRes = await fetch(`${testServer.url}/v1/customers`, {
      method: 'POST',
      headers: { Authorization: 'Bearer sk_test_fake' },
    })
    expect(methodRes.status).toBe(405)
  }, 120_000)

  // ---------------------------------------------------------------------------
  // 15. Stress: 200 segments, 100k objects, 1000 req/s
  // ---------------------------------------------------------------------------

  it('stress: 200 segments with 100k objects at 1000 req/s', async () => {
    const destSchema = uniqueSchema('stress')
    const CONC = 200
    const TOTAL = 100_000
    const BATCH_SIZE = 1000

    const segs = expandState(mkBackfill({ numSegments: CONC }))
    const perSeg = Math.ceil(TOTAL / segs.length)

    const objects: Record<string, unknown>[] = []
    for (let segIdx = 0; segIdx < segs.length; segIdx++) {
      const seg = segs[segIdx]
      const step = Math.max(1, Math.floor((seg.lt - seg.gte - 2) / perSeg))
      for (let j = 0; j < perSeg && objects.length < TOTAL; j++) {
        objects.push(
          makeCustomer(`cus_s_${String(objects.length).padStart(6, '0')}`, seg.gte + 1 + j * step)
        )
      }
    }

    await sourcePool.query('DELETE FROM stripe.customers')
    for (let i = 0; i < objects.length; i += BATCH_SIZE) {
      await upsertObjects(sourcePool, 'stripe', 'customers', objects.slice(i, i + BATCH_SIZE))
    }
    await restartTestServer()

    console.log(`  Stress: seeded ${objects.length} objects across ${segs.length} segments`)

    const { state } = await runSync({
      destSchema,
      sourceOverrides: { backfill_concurrency: CONC, rate_limit: 1_000 },
      state: { customers: pendingState({ numSegments: CONC }) },
    })

    const { rows } = await destPool.query(`SELECT id FROM "${destSchema}"."customers" ORDER BY id`)
    const destIds = new Set(rows.map((r: { id: string }) => r.id))
    const expectedIds = new Set(objects.map((o) => o.id as string))

    const missing = [...expectedIds].filter((id) => !destIds.has(id))
    const unexpected = [...destIds].filter((id) => !expectedIds.has(id))

    expect(
      missing.length,
      `missing ${missing.length} objects, first 10: ${missing.slice(0, 10).join(', ')}`
    ).toBe(0)
    expect(unexpected.length, `unexpected ${unexpected.length} objects`).toBe(0)
    expect(rows.length).toBe(TOTAL)

    const finalState = state.customers as StripeStreamState
    expect(finalState.status).toBe('complete')

    console.log(`  Stress: synced ${rows.length}/${TOTAL} customers, all IDs verified`)
  }, 600_000)

  // ---------------------------------------------------------------------------
  // 16. V2 object sync (sequential pagination, no created filter)
  // ---------------------------------------------------------------------------

  it('v2 stream: syncs v2_core_event_destinations via cursor pagination', async () => {
    const destSchema = uniqueSchema('v2sync')
    const STREAM = 'v2_core_event_destinations'

    await ensureObjectTable(sourcePool, 'stripe', STREAM)

    const v2Objects = Array.from({ length: 10_000 }, (_, i) => ({
      id: `ed_test_${String(i).padStart(5, '0')}`,
      object: 'v2.core.event_destination',
      description: `Event destination ${i}`,
      status: 'enabled',
      enabled_events: ['*'],
      metadata: {},
    }))

    await sourcePool.query(`DELETE FROM stripe."${STREAM}"`)
    await batchUpsert(STREAM, v2Objects)
    await restartTestServer()

    const { state } = await runSync({
      destSchema,
      streams: [{ name: STREAM, sync_mode: 'full_refresh' }],
    })

    const { rows } = await destPool.query(`SELECT id FROM "${destSchema}"."${STREAM}" ORDER BY id`)
    const destIds = new Set(rows.map((r: { id: string }) => r.id))

    for (const obj of v2Objects) {
      expect(destIds.has(obj.id), `missing v2 object ${obj.id}`).toBe(true)
    }
    expect(rows.length).toBe(v2Objects.length)

    const finalState = state[STREAM] as StripeStreamState
    expect(finalState.status).toBe('complete')
  }, 120_000)
})
