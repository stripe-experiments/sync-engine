/**
 * WebSocket Integration Test
 * Tests WebSocket connection, event processing, and database writes
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execSync } from 'child_process'
import pg from 'pg'
import { startPostgres, stopPostgres, queryDbCount, getDatabaseUrl } from './helpers/test-db.js'
import { getStripeClient, checkEnvVars } from './helpers/stripe-client.js'
import { ResourceTracker } from './helpers/cleanup.js'
import { CliProcess, buildCli } from './helpers/cli-process.js'

const CONTAINER_NAME = 'stripe-sync-wss-test'
const DB_NAME = 'app_db'
const PORT = 5438

describe('WebSocket Integration', () => {
  let pool: pg.Pool
  let cli: CliProcess
  const tracker = new ResourceTracker()
  const cwd = process.cwd()
  let stripe: ReturnType<typeof getStripeClient>

  beforeAll(async () => {
    checkEnvVars('STRIPE_API_KEY')
    stripe = getStripeClient()

    // Start PostgreSQL
    pool = await startPostgres({ containerName: CONTAINER_NAME, dbName: DB_NAME, port: PORT })

    // Build CLI
    buildCli(cwd)

    // Run migrations
    execSync('node dist/cli/index.js migrate', {
      cwd,
      env: { ...process.env, DATABASE_URL: getDatabaseUrl(PORT, DB_NAME) },
      stdio: 'pipe',
    })

    // Start CLI in WebSocket mode (USE_WEBSOCKET=true)
    cli = new CliProcess(cwd)
    await cli.start({
      DATABASE_URL: getDatabaseUrl(PORT, DB_NAME),
      STRIPE_API_KEY: process.env.STRIPE_API_KEY!,
      USE_WEBSOCKET: 'true',
      ENABLE_SIGMA: 'false',
      SKIP_BACKFILL: 'true',
    })
  }, 60000)

  afterAll(async () => {
    // Stop CLI
    await cli?.stop()

    // Cleanup Stripe resources
    await tracker.cleanup(stripe)

    // Close pool and stop PostgreSQL
    await pool?.end()
    await stopPostgres(CONTAINER_NAME)
  }, 30000)

  it('should connect via WebSocket (not ngrok)', async () => {
    const logs = cli.getLogs()

    // Should NOT use ngrok
    expect(logs).not.toContain('ngrok tunnel')

    // Should connect via WebSocket
    expect(logs).toContain('Connected to Stripe WebSocket')
  })

  it('should receive and process events via WebSocket', async () => {
    // Create test resources
    const timestamp = Date.now()

    const customer = await stripe.customers.create({
      name: `Test Customer ${timestamp}`,
      email: `test-${timestamp}@example.com`,
      metadata: { test: 'wss-integration' },
    })
    tracker.trackCustomer(customer.id)

    const product = await stripe.products.create({
      name: `Test Product ${timestamp}`,
      metadata: { test: 'wss-integration' },
    })
    tracker.trackProduct(product.id)

    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: 1000,
      currency: 'usd',
      metadata: { test: 'wss-integration' },
    })
    tracker.trackPrice(price.id)

    // Wait for events to be processed
    await sleep(10000)

    // Check logs for events received
    const logs = cli.getLogs()
    const eventCount = (logs.match(/← /g) || []).length
    expect(eventCount).toBeGreaterThan(0)

    // CLI should still be running
    expect(cli.isRunning()).toBe(true)
  }, 30000)

  it('should write events to database', async () => {
    // Verify data in database
    const customerCount = await queryDbCount(pool, 'SELECT COUNT(*) FROM stripe.customers')
    expect(customerCount).toBeGreaterThan(0)

    const productCount = await queryDbCount(pool, 'SELECT COUNT(*) FROM stripe.products')
    expect(productCount).toBeGreaterThan(0)

    const priceCount = await queryDbCount(pool, 'SELECT COUNT(*) FROM stripe.prices')
    expect(priceCount).toBeGreaterThan(0)
  })

  it('should not have WebSocket errors', async () => {
    const logs = cli.getLogs()
    expect(logs).not.toContain('WebSocket error')
  })
})

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
