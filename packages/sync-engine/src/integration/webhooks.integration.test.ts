/**
 * Webhook Integration Test
 * Tests webhook creation, event processing, and database writes
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execSync } from 'child_process'
import * as crypto from 'crypto'
import pg from 'pg'
import {
  startPostgres,
  stopPostgres,
  queryDb,
  queryDbCount,
  getDatabaseUrl,
} from './helpers/test-db.js'
import { getStripeClient, checkEnvVars } from './helpers/stripe-client.js'
import { ResourceTracker } from './helpers/cleanup.js'
import { CliProcess, buildCli } from './helpers/cli-process.js'

const CONTAINER_NAME = 'stripe-sync-test-webhooks'
const DB_NAME = 'app_db'
const PORT = 5433

describe('Webhook Integration', () => {
  let pool: pg.Pool
  let cli: CliProcess
  const tracker = new ResourceTracker()
  const cwd = process.cwd()

  beforeAll(async () => {
    checkEnvVars('STRIPE_API_KEY', 'NGROK_AUTH_TOKEN')

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

    // Start CLI in background
    cli = new CliProcess(cwd)
    await cli.start({
      DATABASE_URL: getDatabaseUrl(PORT, DB_NAME),
      STRIPE_API_KEY: process.env.STRIPE_API_KEY!,
      NGROK_AUTH_TOKEN: process.env.NGROK_AUTH_TOKEN!,
      ENABLE_SIGMA: 'false',
      KEEP_WEBHOOKS_ON_SHUTDOWN: 'false',
    })
  }, 60000)

  afterAll(async () => {
    // Stop CLI
    await cli?.stop()

    // Cleanup Stripe resources
    const stripe = getStripeClient()
    await tracker.cleanup(stripe)

    // Close pool and stop PostgreSQL
    await pool?.end()
    await stopPostgres(CONTAINER_NAME)
  }, 30000)

  it('should create webhook and persist to database', async () => {
    // Check logs for webhook creation
    const logs = cli.getLogs()
    expect(logs).toContain('Webhook created:')

    // Verify webhook in database
    const webhookCount = await queryDbCount(pool, 'SELECT COUNT(*) FROM stripe._managed_webhooks')
    expect(webhookCount).toBeGreaterThan(0)
  })

  it('should process customer.created webhook event', async () => {
    const stripe = getStripeClient()

    // Create customer via Stripe API
    const customer = await stripe.customers.create({
      email: 'webhook-test@example.com',
      name: 'Webhook Test Customer',
    })
    tracker.trackCustomer(customer.id)

    // Wait for webhook processing
    await sleep(5000)

    // Verify customer in database
    const customers = await queryDb<{ id: string }>(
      pool,
      `SELECT id FROM stripe.customers WHERE id = '${customer.id}'`
    )
    expect(customers.length).toBe(1)
  })

  it('should process product.created webhook event', async () => {
    const stripe = getStripeClient()

    // Create product via Stripe API
    const product = await stripe.products.create({
      name: 'Webhook Test Product',
    })
    tracker.trackProduct(product.id)

    // Wait for webhook processing
    await sleep(5000)

    // Verify product in database
    const products = await queryDb<{ id: string }>(
      pool,
      `SELECT id FROM stripe.products WHERE id = '${product.id}'`
    )
    expect(products.length).toBe(1)
  })

  it('should process price.created webhook event', async () => {
    const stripe = getStripeClient()

    // Need a product first
    const product = await stripe.products.create({
      name: 'Price Test Product',
    })
    tracker.trackProduct(product.id)

    // Create price
    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: 1000,
      currency: 'usd',
    })
    tracker.trackPrice(price.id)

    // Wait for webhook processing
    await sleep(5000)

    // Verify price in database
    const prices = await queryDb<{ id: string }>(
      pool,
      `SELECT id FROM stripe.prices WHERE id = '${price.id}'`
    )
    expect(prices.length).toBe(1)
  })

  it('should handle unsupported webhook events gracefully', async () => {
    // Get webhook URL and secret from database
    const webhooks = await queryDb<{ url: string; secret: string }>(
      pool,
      'SELECT url, secret FROM stripe._managed_webhooks LIMIT 1'
    )
    expect(webhooks.length).toBeGreaterThan(0)

    const { url, secret } = webhooks[0]
    const timestamp = Math.floor(Date.now() / 1000)

    // Create unsupported event payload
    const payload = JSON.stringify({
      id: `evt_test_unsupported_${timestamp}`,
      object: 'event',
      api_version: '2020-08-27',
      created: timestamp,
      type: 'balance.available',
      data: {
        object: {
          object: 'balance',
          available: [{ amount: 1000, currency: 'usd' }],
          livemode: false,
        },
      },
    })

    // Generate signature
    const signaturePayload = `${timestamp}.${payload}`
    const signature = crypto.createHmac('sha256', secret).update(signaturePayload).digest('hex')

    // Send request
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Stripe-Signature': `t=${timestamp},v1=${signature}`,
      },
      body: payload,
    })

    // Should return 200 (handled gracefully)
    expect(response.status).toBe(200)

    // CLI should still be running
    expect(cli.isRunning()).toBe(true)
  })

  it('should cleanup webhook on shutdown', async () => {
    // Stop CLI
    await cli.stop()

    // Wait for cleanup
    await sleep(2000)

    // Verify webhook removed from database
    const webhookCount = await queryDbCount(pool, 'SELECT COUNT(*) FROM stripe._managed_webhooks')
    expect(webhookCount).toBe(0)
  })
})

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
