/**
 * WebSocket E2E Test
 * Tests WebSocket connection, event processing, and database writes
 * This test does NOT require ngrok or Stripe CLI - uses Stripe's WebSocket API directly
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

describe('WebSocket E2E', () => {
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
    console.log('cli logs: ', cli.getLogs())

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

  it('should sync plan creation and deletion', async () => {
    const timestamp = Date.now()

    // 1. Create a product first (plans require a product)
    const product = await stripe.products.create({
      name: `Plan Test Product ${timestamp}`,
      metadata: { test: 'wss-plan-integration' },
    })
    tracker.trackProduct(product.id)

    // 2. Create a plan
    const plan = await stripe.plans.create({
      amount: 2000,
      currency: 'usd',
      interval: 'month',
      product: product.id,
      nickname: `Test Plan ${timestamp}`,
      metadata: { test: 'wss-plan-integration' },
    })
    tracker.trackPlan(plan.id)

    // Wait for plan creation event
    await sleep(10000)

    // Verify plan in database
    const planCount = await queryDbCount(pool, 'SELECT COUNT(*) FROM stripe.plans WHERE id = $1', [
      plan.id,
    ])
    expect(planCount).toBe(1)

    // 3. Delete the plan
    await stripe.plans.del(plan.id)

    // Wait for plan deletion event
    await sleep(10000)

    // Verify plan is removed from database
    const planCountAfterDelete = await queryDbCount(
      pool,
      'SELECT COUNT(*) FROM stripe.plans WHERE id = $1',
      [plan.id]
    )
    expect(planCountAfterDelete).toBe(0)
  }, 40000)

  it('should sync customer creation and soft deletion', async () => {
    const timestamp = Date.now()

    // 1. Create a customer
    const customer = await stripe.customers.create({
      name: `Soft Delete Test Customer ${timestamp}`,
      email: `soft-delete-${timestamp}@example.com`,
      metadata: { test: 'wss-customer-soft-delete' },
    })
    tracker.trackCustomer(customer.id)

    // Wait for customer creation event
    await sleep(10000)

    // Verify customer in database
    const customerCount = await queryDbCount(
      pool,
      'SELECT COUNT(*) FROM stripe.customers WHERE id = $1',
      [customer.id]
    )
    expect(customerCount).toBe(1)

    // 2. Delete the customer
    await stripe.customers.del(customer.id)

    // Wait for customer deletion event
    await sleep(10000)

    // Verify customer still exists in database but has deleted = true
    const customerData = await pool.query('SELECT deleted FROM stripe.customers WHERE id = $1', [
      customer.id,
    ])
    expect(customerData.rows.length).toBe(1)
    expect(customerData.rows[0].deleted).toBe(true)
  }, 40000)
})

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
