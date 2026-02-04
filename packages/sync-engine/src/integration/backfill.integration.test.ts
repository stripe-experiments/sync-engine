/**
 * Backfill Integration Test
 * Tests backfill command with real Stripe data and incremental sync
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execSync } from 'child_process'
import pg from 'pg'
import {
  startPostgres,
  stopPostgres,
  queryDbCount,
  queryDbSingle,
  getDatabaseUrl,
} from './helpers/test-db.js'
import { getStripeClient, checkEnvVars } from './helpers/stripe-client.js'
import { ResourceTracker } from './helpers/cleanup.js'
import { buildCli, runCliCommand } from './helpers/cli-process.js'

const CONTAINER_NAME = 'stripe-sync-test-backfill'
const DB_NAME = 'app_db'
const PORT = 5434

describe('Backfill Integration', () => {
  let pool: pg.Pool
  const tracker = new ResourceTracker()
  const cwd = process.cwd()
  let stripe: ReturnType<typeof getStripeClient>

  // Store created resource IDs
  const customerIds: string[] = []
  const productIds: string[] = []
  const priceIds: string[] = []

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

    // Create test data in Stripe
    // Create 3 customers
    for (let i = 1; i <= 3; i++) {
      const customer = await stripe.customers.create({
        email: `test-backfill-${i}@example.com`,
        name: `Test Customer ${i}`,
        description: `Integration test customer ${i}`,
      })
      customerIds.push(customer.id)
      tracker.trackCustomer(customer.id)
    }

    // Create 3 products
    for (let i = 1; i <= 3; i++) {
      const product = await stripe.products.create({
        name: `Test Product ${i} - Backfill`,
        description: `Integration test product ${i}`,
      })
      productIds.push(product.id)
      tracker.trackProduct(product.id)
    }

    // Create 3 prices
    for (let i = 0; i < 3; i++) {
      const priceParams: {
        product: string
        unit_amount: number
        currency: string
        nickname: string
        recurring?: { interval: 'month' | 'year' | 'week' | 'day' }
      } = {
        product: productIds[i],
        unit_amount: (i + 1) * 1000,
        currency: 'usd',
        nickname: `Test Price ${i + 1}`,
      }
      if (i === 2) {
        priceParams.recurring = { interval: 'month' }
      }
      const price = await stripe.prices.create(priceParams)
      priceIds.push(price.id)
      tracker.trackPrice(price.id)
    }
  }, 120000)

  afterAll(async () => {
    // Cleanup Stripe resources
    await tracker.cleanup(stripe)

    // Close pool and stop PostgreSQL
    await pool?.end()
    await stopPostgres(CONTAINER_NAME)
  }, 30000)

  it('should backfill all data from Stripe', async () => {
    // Run backfill all
    runCliCommand('backfill', ['all'], {
      cwd,
      env: { DATABASE_URL: getDatabaseUrl(PORT, DB_NAME) },
    })

    // Verify customers
    const customerCount = await queryDbCount(
      pool,
      "SELECT COUNT(*) FROM stripe.customers WHERE email LIKE 'test-backfill-%'"
    )
    expect(customerCount).toBeGreaterThanOrEqual(3)

    // Verify products
    const productCount = await queryDbCount(
      pool,
      "SELECT COUNT(*) FROM stripe.products WHERE name LIKE '%Backfill%'"
    )
    expect(productCount).toBeGreaterThanOrEqual(3)

    // Verify prices
    const priceCount = await queryDbCount(
      pool,
      "SELECT COUNT(*) FROM stripe.prices WHERE nickname LIKE 'Test Price%'"
    )
    expect(priceCount).toBeGreaterThanOrEqual(3)
  }, 120000)

  it('should save sync cursor after backfill', async () => {
    // Get account ID from synced data
    const accountRow = await queryDbSingle<{ _account_id: string }>(
      pool,
      'SELECT DISTINCT _account_id FROM stripe.products LIMIT 1'
    )
    expect(accountRow).not.toBeNull()
    const accountId = accountRow!._account_id

    // Check cursor was saved
    const cursorRow = await queryDbSingle<{ cursor: string }>(
      pool,
      `SELECT cursor FROM stripe._sync_obj_runs o
       JOIN stripe._sync_runs r ON o._account_id = r._account_id AND o.run_started_at = r.started_at
       WHERE o._account_id = '${accountId}' AND o.object = 'products' AND o.status = 'complete'
       ORDER BY o.completed_at DESC LIMIT 1`
    )
    expect(cursorRow).not.toBeNull()
    expect(parseInt(cursorRow!.cursor, 10)).toBeGreaterThan(0)
  })

  it('should have sync status as complete', async () => {
    const accountRow = await queryDbSingle<{ _account_id: string }>(
      pool,
      'SELECT DISTINCT _account_id FROM stripe.products LIMIT 1'
    )
    const accountId = accountRow!._account_id

    const statusRow = await queryDbSingle<{ status: string }>(
      pool,
      `SELECT o.status FROM stripe._sync_obj_runs o
       JOIN stripe._sync_runs r ON o._account_id = r._account_id AND o.run_started_at = r.started_at
       WHERE o._account_id = '${accountId}' AND o.object = 'products'
       ORDER BY r.started_at DESC LIMIT 1`
    )
    expect(statusRow?.status).toBe('complete')
  })

  it('should perform incremental sync on subsequent backfill', async () => {
    // Get initial cursor
    const accountRow = await queryDbSingle<{ _account_id: string }>(
      pool,
      'SELECT DISTINCT _account_id FROM stripe.products LIMIT 1'
    )
    const accountId = accountRow!._account_id

    const initialCursorRow = await queryDbSingle<{ cursor: string }>(
      pool,
      `SELECT cursor FROM stripe._sync_obj_runs o
       JOIN stripe._sync_runs r ON o._account_id = r._account_id AND o.run_started_at = r.started_at
       WHERE o._account_id = '${accountId}' AND o.object = 'products' AND o.status = 'complete'
       ORDER BY o.completed_at DESC LIMIT 1`
    )
    const initialCursor = parseInt(initialCursorRow!.cursor, 10)

    // Create new product after first backfill
    const newProduct = await stripe.products.create({
      name: 'Test Product 4 - Incremental',
      description: 'Integration test product 4 - created after first backfill',
    })
    productIds.push(newProduct.id)
    tracker.trackProduct(newProduct.id)

    // Wait to ensure different timestamps
    await sleep(2000)

    // Run incremental backfill
    runCliCommand('backfill', ['product'], {
      cwd,
      env: { DATABASE_URL: getDatabaseUrl(PORT, DB_NAME) },
    })

    // Verify cursor advanced
    const newCursorRow = await queryDbSingle<{ cursor: string }>(
      pool,
      `SELECT cursor FROM stripe._sync_obj_runs o
       JOIN stripe._sync_runs r ON o._account_id = r._account_id AND o.run_started_at = r.started_at
       WHERE o._account_id = '${accountId}' AND o.object = 'products' AND o.status = 'complete'
       ORDER BY o.completed_at DESC LIMIT 1`
    )
    const newCursor = parseInt(newCursorRow!.cursor, 10)
    expect(newCursor).toBeGreaterThan(initialCursor)

    // Verify new product was synced
    const newProductInDb = await queryDbCount(
      pool,
      `SELECT COUNT(*) FROM stripe.products WHERE id = '${newProduct.id}'`
    )
    expect(newProductInDb).toBe(1)

    // Verify all test products exist
    const totalProducts = await queryDbCount(
      pool,
      `SELECT COUNT(*) FROM stripe.products WHERE id IN (${productIds.map((id) => `'${id}'`).join(',')})`
    )
    expect(totalProducts).toBe(productIds.length)
  }, 60000)
})

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
