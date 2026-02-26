/**
 * WebSocket E2E Test
 * Tests WebSocket connection, event processing, and database writes
 * This test does NOT require ngrok or Stripe CLI - uses Stripe's WebSocket API directly
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execSync } from 'child_process'
import pg from 'pg'
import {
  startPostgresContainer,
  queryDbCount,
  getStripeClient,
  checkEnvVars,
  sleep,
  type PostgresContainer,
} from '../testSetup'
import { ResourceTracker } from './helpers/cleanup.js'
import { CliProcess } from './helpers/cli-process.js'

describe('WebSocket E2E', () => {
  let pool: pg.Pool
  let container: PostgresContainer
  let cli: CliProcess
  const tracker = new ResourceTracker()
  const cwd = process.cwd()
  let stripe: ReturnType<typeof getStripeClient>

  beforeAll(async () => {
    checkEnvVars('STRIPE_API_KEY')
    stripe = getStripeClient()

    container = await startPostgresContainer()
    pool = new pg.Pool({ connectionString: container.databaseUrl })

    execSync('node dist/cli/index.js migrate', {
      cwd,
      env: { ...process.env, DATABASE_URL: container.databaseUrl },
      stdio: 'pipe',
    })

    cli = new CliProcess(cwd)
    await cli.start({
      DATABASE_URL: container.databaseUrl,
      STRIPE_API_KEY: process.env.STRIPE_API_KEY!,
      USE_WEBSOCKET: 'true',
      ENABLE_SIGMA: 'false',
      SKIP_BACKFILL: 'true',
    })
  }, 60000)

  afterAll(async () => {
    await cli?.stop()
    await tracker.cleanup(stripe)
    console.log('cli logs: ', cli?.getLogs())
    await pool?.end()
    await container?.stop()
  }, 30000)

  it('should connect via WebSocket (not ngrok)', async () => {
    const logs = cli.getLogs()
    expect(logs).not.toContain('ngrok tunnel')
    expect(logs).toContain('Connected to Stripe WebSocket')
  })

  it('should receive and process events via WebSocket', async () => {
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

    await sleep(10000)

    const logs = cli.getLogs()
    const eventCount = (logs.match(/← /g) || []).length
    expect(eventCount).toBeGreaterThan(0)

    expect(cli.isRunning()).toBe(true)
  }, 30000)

  it('should write events to database', async () => {
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

    const product = await stripe.products.create({
      name: `Plan Test Product ${timestamp}`,
      metadata: { test: 'wss-plan-integration' },
    })
    tracker.trackProduct(product.id)

    const plan = await stripe.plans.create({
      amount: 2000,
      currency: 'usd',
      interval: 'month',
      product: product.id,
      nickname: `Test Plan ${timestamp}`,
      metadata: { test: 'wss-plan-integration' },
    })
    tracker.trackPlan(plan.id)

    await sleep(10000)

    const planCount = await queryDbCount(pool, 'SELECT COUNT(*) FROM stripe.plans WHERE id = $1', [
      plan.id,
    ])
    expect(planCount).toBe(1)

    await stripe.plans.del(plan.id)

    await sleep(10000)

    const planCountAfterDelete = await queryDbCount(
      pool,
      'SELECT COUNT(*) FROM stripe.plans WHERE id = $1',
      [plan.id]
    )
    expect(planCountAfterDelete).toBe(0)
  }, 40000)

  it('should sync customer creation and soft deletion', async () => {
    const timestamp = Date.now()

    const customer = await stripe.customers.create({
      name: `Soft Delete Test Customer ${timestamp}`,
      email: `soft-delete-${timestamp}@example.com`,
      metadata: { test: 'wss-customer-soft-delete' },
    })
    tracker.trackCustomer(customer.id)

    await sleep(10000)

    const customerCount = await queryDbCount(
      pool,
      'SELECT COUNT(*) FROM stripe.customers WHERE id = $1',
      [customer.id]
    )
    expect(customerCount).toBe(1)

    await stripe.customers.del(customer.id)

    await sleep(10000)

    const customerData = await pool.query('SELECT deleted FROM stripe.customers WHERE id = $1', [
      customer.id,
    ])
    expect(customerData.rows.length).toBe(1)
    expect(customerData.rows[0].deleted).toBe(true)
  }, 40000)
})
