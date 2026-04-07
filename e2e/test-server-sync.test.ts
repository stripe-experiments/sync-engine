import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execSync } from 'node:child_process'
import pg from 'pg'
import path from 'node:path'
import {
  startDockerPostgres18,
  createStripeListServer,
  type DockerPostgres18Handle,
  type StripeListServer,
} from '@stripe/sync-test-utils'

// ---------------------------------------------------------------------------
// Config — env vars allow CI to override defaults
// ---------------------------------------------------------------------------

const SERVICE_URL = process.env.SERVICE_URL ?? 'http://localhost:4020'
const STRIPE_MOCK_URL = process.env.STRIPE_MOCK_URL ?? 'http://localhost:12111'

// Hostname containers use to reach the host machine.
// CI runs containers with --network=host → localhost works.
// Local compose → host.docker.internal.
const CONTAINER_HOST = process.env.CONTAINER_HOST ?? 'host.docker.internal'

const SKIP_SETUP = process.env.SKIP_SETUP === '1'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const COMPOSE_CMD = `docker compose -f compose.yml -f compose.dev.yml -f e2e/compose.e2e.yml`

const CUSTOMER_COUNT = 10_000
const SEED_BATCH = 1000

function utc(date: string): number {
  return Math.floor(new Date(date + 'T00:00:00Z').getTime() / 1000)
}

const RANGE_START = utc('2021-04-03')
const RANGE_END = utc('2026-04-02')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function pollUntil(
  fn: () => Promise<boolean>,
  { timeout = 300_000, interval = 2000 } = {}
): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, interval))
  }
  throw new Error(`pollUntil timed out after ${timeout}ms`)
}

async function isServiceHealthy(): Promise<boolean> {
  try {
    const r = await fetch(`${SERVICE_URL}/health`)
    return r.ok
  } catch {
    return false
  }
}

async function ensureDockerStack(): Promise<void> {
  console.log('\n  Building packages...')
  execSync('pnpm build', { cwd: REPO_ROOT, stdio: 'inherit' })
  console.log('  Starting Docker stack...')
  execSync(`${COMPOSE_CMD} up --build -d stripe-mock temporal engine service worker`, {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  })
  console.log('  Waiting for service health...')
  await pollUntil(isServiceHealthy, { timeout: 180_000 })
}

async function ensureStripeMock(): Promise<void> {
  execSync('docker compose up -d stripe-mock', { cwd: REPO_ROOT, stdio: 'pipe' })
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${STRIPE_MOCK_URL}/v1/customers`, {
        headers: { Authorization: 'Bearer sk_test_fake' },
      })
      if (res.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('stripe-mock did not become ready')
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('test-server sync via Docker service: 10k customers', () => {
  let sourceDocker: DockerPostgres18Handle
  let destDocker: DockerPostgres18Handle
  let testServer: StripeListServer
  let destPool: pg.Pool
  let expectedIds: string[]

  beforeAll(async () => {
    // 1. Build, start Docker stack (infra + app), and start source/dest Postgres.
    if (SKIP_SETUP) {
      console.log('\n  SKIP_SETUP=1 — ensuring stripe-mock is up')
      await ensureStripeMock()
    } else {
      await ensureDockerStack()
    }

    const [src, dest] = await Promise.all([startDockerPostgres18(), startDockerPostgres18()])
    sourceDocker = src
    destDocker = dest

    destPool = new pg.Pool({ connectionString: destDocker.connectionString })
    destPool.on('error', () => {})

    // 2. Start test server on 0.0.0.0 so Docker containers can reach it.
    testServer = await createStripeListServer({
      postgresUrl: sourceDocker.connectionString,
      host: '0.0.0.0',
      port: 0,
      accountCreated: RANGE_START,
      seedCustomers: {
        stripeMockUrl: STRIPE_MOCK_URL,
        count: CUSTOMER_COUNT,
        batchSize: SEED_BATCH,
        createdRange: { startUnix: RANGE_START, endUnix: RANGE_END },
      },
    })
    expectedIds = testServer.seededCustomerIds!
    expect(expectedIds.length).toBe(CUSTOMER_COUNT)

    console.log(`  Source PG:       ${sourceDocker.connectionString}`)
    console.log(`  Dest PG:         ${destDocker.connectionString}`)
    console.log(`  Test server:     http://0.0.0.0:${testServer.port}`)
    console.log(`  Service API:     ${SERVICE_URL}`)
    console.log(`  Container host:  ${CONTAINER_HOST}`)
  }, 10 * 60_000)

  afterAll(async () => {
    await testServer?.close().catch(() => {})
    await destPool?.end().catch(() => {})
    await destDocker?.stop()
    await sourceDocker?.stop()
  }, 60_000)

  it(
    'POST /pipelines syncs 10k customers from test server to Postgres',
    async () => {
      const destSchema = `e2e_server_sync_${Date.now()}`

      // URLs rewritten for container access (host.docker.internal or localhost).
      const testServerContainerUrl = `http://${CONTAINER_HOST}:${testServer.port}`
      const destPgContainerUrl = destDocker.connectionString.replace('localhost', CONTAINER_HOST)

      const createRes = await fetch(`${SERVICE_URL}/pipelines`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: {
            type: 'stripe',
            stripe: {
              api_key: 'sk_test_fake',
              base_url: testServerContainerUrl,
              rate_limit: 1000,
            },
          },
          destination: {
            type: 'postgres',
            postgres: {
              connection_string: destPgContainerUrl,
              schema: destSchema,
            },
          },
          streams: [{ name: 'customers' }],
        }),
      })
      expect(createRes.status).toBe(201)
      const created = (await createRes.json()) as { id: string }
      const id = created.id
      expect(id).toMatch(/^pipe_/)
      console.log(`\n  Pipeline: ${id}`)

      await pollUntil(async () => {
        try {
          const r = await destPool.query(
            `SELECT count(*)::int AS n FROM "${destSchema}"."customers"`
          )
          return r.rows[0].n === expectedIds.length
        } catch {
          return false
        }
      })

      const { rows } = await destPool.query(
        `SELECT id FROM "${destSchema}"."customers" ORDER BY id`
      )
      const destIds = new Set(rows.map((r: { id: string }) => r.id))
      expect(destIds.size).toBe(expectedIds.length)
      for (const expectedId of expectedIds) {
        expect(destIds.has(expectedId), `missing ${expectedId}`).toBe(true)
      }
      console.log(`  Synced:   ${destIds.size} customers`)

      // --- Delete pipeline ---
      const delRes = await fetch(`${SERVICE_URL}/pipelines/${id}`, { method: 'DELETE' })
      expect(delRes.status).toBe(200)

      await destPool.query(`DROP SCHEMA IF EXISTS "${destSchema}" CASCADE`)
    },
    15 * 60_000
  )
})
