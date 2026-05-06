/**
 * Verifies the Temporal `reconcileCleanup` activity tombstones rows for
 * records that were hard-deleted in Stripe without the corresponding
 * `*.deleted` event being processed — the "missed delete" path that
 * complements stripe-delete.test.ts (the event-driven path).
 *
 * Seeds destination rows via in-process engine, then runs the production
 * activity through `MockActivityEnvironment` so the composition
 * (`pg.getStaleRecords` → `stripe.verifyRecords` → `pg.write`) is exercised
 * end-to-end with a Temporal Activity Context active (heartbeats become no-ops).
 */
import pg from 'pg'
import Stripe from 'stripe'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { MockActivityEnvironment } from '@temporalio/testing'
import source from '@stripe/sync-source-stripe'
import destinationPostgres from '@stripe/sync-destination-postgres'
import { createEngine } from '@stripe/sync-engine'
import type { ConnectorResolver } from '@stripe/sync-engine'
import { createActivities } from '@stripe/sync-service'
import type { Pipeline } from '@stripe/sync-service'
import { drain } from '@stripe/sync-protocol'
import { describeWithEnv } from './test-helpers.js'

const POSTGRES_URL =
  process.env.POSTGRES_URL ?? 'postgresql://postgres:postgres@localhost:5432/postgres'
const ts = new Date()
  .toISOString()
  .replace(/[-:T.Z]/g, '')
  .slice(0, 15)
const STREAM = 'customer'
const BACKFILL_LIMIT = 10

function memoryPipelineStore() {
  const data = new Map<string, Pipeline>()
  return {
    async get(id: string) {
      const p = data.get(id)
      if (!p) throw new Error(`Pipeline not found: ${id}`)
      return p
    },
    async set(id: string, pipeline: Pipeline) {
      data.set(id, pipeline)
    },
    async update(id: string, patch: Partial<Omit<Pipeline, 'id'>>) {
      const existing = data.get(id)
      if (!existing) throw new Error(`Pipeline not found: ${id}`)
      const updated = { ...existing, ...patch, id } as Pipeline
      data.set(id, updated)
      return updated
    },
    async delete(id: string) {
      data.delete(id)
    },
    async list() {
      return [...data.values()]
    },
  }
}

describeWithEnv(
  'temporal reconcile-cleanup activity → postgres (missed delete)',
  ['STRIPE_API_KEY'],
  ({ STRIPE_API_KEY }) => {
    const SCHEMA = `e2e_recon_pg_${ts}`
    const PIPELINE_ID = `pipe_recon_${ts}`
    let pool: pg.Pool
    let stripe: Stripe

    const sourceConfig = { api_key: STRIPE_API_KEY, backfill_limit: BACKFILL_LIMIT }
    const destConfig = { url: POSTGRES_URL, schema: SCHEMA, batch_size: 100 }

    const resolver: ConnectorResolver = {
      resolveSource: async (name) => {
        if (name !== 'stripe') throw new Error(`Unknown source: ${name}`)
        return source
      },
      resolveDestination: async (name) => {
        if (name !== 'postgres') throw new Error(`Unknown destination: ${name}`)
        return destinationPostgres
      },
      sources: () => new Map(),
      destinations: () => new Map(),
    }

    function makePipeline() {
      return {
        source: { type: 'stripe', stripe: sourceConfig },
        destination: { type: 'postgres', postgres: destConfig },
        streams: [{ name: STREAM }],
      }
    }

    beforeAll(async () => {
      pool = new pg.Pool({ connectionString: POSTGRES_URL })
      await pool.query('SELECT 1')
      await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
      stripe = new Stripe(STRIPE_API_KEY)
      const account = await stripe.accounts.retrieve()
      console.log(`\n  Postgres:       ${POSTGRES_URL} (schema: ${SCHEMA})`)
      console.log(`  Stripe account: ${account.id}`)
      console.log(`  Pipeline:       ${PIPELINE_ID}`)
    })

    afterAll(async () => {
      if (!pool) return
      if (!process.env.KEEP_TEST_DATA) {
        await pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
      }
      await pool.end()
    })

    it('tombstones customers deleted in stripe without a delete event', async () => {
      const engine = await createEngine(resolver)
      const pipeline = makePipeline()
      const pipelineStore = memoryPipelineStore()
      await pipelineStore.set(PIPELINE_ID, { id: PIPELINE_ID, ...pipeline } as Pipeline)

      await drain(engine.pipeline_setup(pipeline))

      const survivor = await stripe.customers.create({
        name: `e2e-recon-survivor-${Date.now()}`,
      })
      const doomed = await stripe.customers.create({
        name: `e2e-recon-doomed-${Date.now()}`,
      })
      const cleanupIds = new Set<string>([survivor.id, doomed.id])

      try {
        // Backfill-only sync (no websocket, no event polling) — both rows
        // land in postgres with `_synced_at ≈ T0`.
        for await (const _msg of engine.pipeline_sync(pipeline)) {
          void _msg
        }

        const seeded = await pool.query<{ id: string }>(
          `SELECT id FROM "${SCHEMA}"."${STREAM}" WHERE id = ANY($1)`,
          [[survivor.id, doomed.id]]
        )
        expect(new Set(seeded.rows.map((r) => r.id))).toEqual(new Set([survivor.id, doomed.id]))

        // Hard-delete one customer WITHOUT replaying the customer.deleted
        // event — this is the "missed delete" reconcile-cleanup catches.
        await stripe.customers.del(doomed.id)
        cleanupIds.delete(doomed.id)

        // `_synced_at` is set with millisecond precision by the destination,
        // so a small forward skew guarantees `syncRunStartedAt > _synced_at`.
        await new Promise((r) => setTimeout(r, 50))
        const syncRunStartedAt = new Date().toISOString()

        // engineUrl is unused by reconcileCleanup (it instantiates connectors
        // in-process); other activities in the bundle don't run here.
        const activities = createActivities({ engineUrl: 'http://unused', pipelineStore })

        const env = new MockActivityEnvironment()
        await env.run(activities.reconcileCleanup, PIPELINE_ID, syncRunStartedAt)

        const after = await pool.query<{ id: string }>(
          `SELECT id FROM "${SCHEMA}"."${STREAM}" WHERE id = ANY($1)`,
          [[survivor.id, doomed.id]]
        )
        const remaining = new Set(after.rows.map((r) => r.id))
        expect(remaining.has(survivor.id), `survivor ${survivor.id} was tombstoned`).toBe(true)
        expect(remaining.has(doomed.id), `doomed ${doomed.id} was not tombstoned`).toBe(false)
        console.log(`    Survived:   ${survivor.id}`)
        console.log(`    Tombstoned: ${doomed.id}`)
      } finally {
        if (!process.env.KEEP_TEST_DATA) {
          for (const id of cleanupIds) {
            try {
              await stripe.customers.del(id)
            } catch {}
          }
        }
      }
    }, 180_000)
  }
)
