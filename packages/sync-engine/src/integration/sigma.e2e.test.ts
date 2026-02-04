/**
 * Sigma E2E Test
 * Tests Sigma table sync functionality with --sigma flag
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

const CONTAINER_NAME = 'stripe-sync-sigma-test'
const DB_NAME = 'app_db'
const PORT = 5440

describe('Sigma E2E', () => {
  let pool: pg.Pool
  const tracker = new ResourceTracker()
  const cwd = process.cwd()
  let stripe: ReturnType<typeof getStripeClient>
  let productId: string

  beforeAll(async () => {
    // Sigma tests use STRIPE_API_KEY_3 (Sigma-enabled account)
    checkEnvVars('STRIPE_API_KEY_3')
    stripe = getStripeClient('STRIPE_API_KEY_3')

    // Start PostgreSQL
    pool = await startPostgres({ containerName: CONTAINER_NAME, dbName: DB_NAME, port: PORT })

    // Build CLI
    buildCli(cwd)

    // Run migrations with sigma tables
    execSync('node dist/cli/index.js migrate --sigma', {
      cwd,
      env: {
        ...process.env,
        DATABASE_URL: getDatabaseUrl(PORT, DB_NAME),
        STRIPE_API_KEY: process.env.STRIPE_API_KEY_3,
      },
      stdio: 'pipe',
    })

    // Create a test product so backfill has something to sync
    const product = await stripe.products.create({
      name: 'Sigma Test Product',
      description: 'Integration test product for sigma test',
    })
    productId = product.id
    tracker.trackProduct(productId)
  }, 120000)

  afterAll(async () => {
    // Cleanup Stripe resources
    await tracker.cleanup(stripe)

    // Close pool and stop PostgreSQL
    await pool?.end()
    await stopPostgres(CONTAINER_NAME)
  }, 30000)

  it('should backfill products (non-sigma)', async () => {
    runCliCommand('backfill', ['product'], {
      cwd,
      env: {
        DATABASE_URL: getDatabaseUrl(PORT, DB_NAME),
        STRIPE_API_KEY: process.env.STRIPE_API_KEY_3!,
      },
    })

    // Verify product in database
    const productCount = await queryDbCount(
      pool,
      `SELECT COUNT(*) FROM stripe.products WHERE id = '${productId}'`
    )
    expect(productCount).toBe(1)
  }, 60000)

  it('should backfill subscription_item_change_events_v2_beta (sigma)', async () => {
    runCliCommand('backfill', ['--sigma', 'subscription_item_change_events_v2_beta'], {
      cwd,
      env: {
        DATABASE_URL: getDatabaseUrl(PORT, DB_NAME),
        STRIPE_API_KEY: process.env.STRIPE_API_KEY_3!,
      },
    })

    // Verify data in sigma schema
    const count = await queryDbCount(
      pool,
      'SELECT COUNT(*) FROM sigma.subscription_item_change_events_v2_beta'
    )
    expect(count).toBeGreaterThan(0)
  }, 60000)

  it('should backfill exchange_rates_from_usd (sigma)', async () => {
    runCliCommand('backfill', ['--sigma', 'exchange_rates_from_usd'], {
      cwd,
      env: {
        DATABASE_URL: getDatabaseUrl(PORT, DB_NAME),
        STRIPE_API_KEY: process.env.STRIPE_API_KEY_3!,
      },
    })

    // Verify data in sigma schema
    const count = await queryDbCount(pool, 'SELECT COUNT(*) FROM sigma.exchange_rates_from_usd')
    expect(count).toBeGreaterThan(0)
  }, 60000)

  it('should track sync status correctly', async () => {
    // Get account ID from sigma tables
    const accountRow = await queryDbSingle<{ _account_id: string }>(
      pool,
      'SELECT DISTINCT _account_id FROM sigma.subscription_item_change_events_v2_beta LIMIT 1'
    )

    if (!accountRow) {
      // Try exchange_rates table
      const accountRow2 = await queryDbSingle<{ _account_id: string }>(
        pool,
        'SELECT DISTINCT _account_id FROM sigma.exchange_rates_from_usd LIMIT 1'
      )
      expect(accountRow2).not.toBeNull()
    }

    const accountId = accountRow?._account_id

    if (accountId) {
      // Check sync status for sigma tables
      const siceStatus = await queryDbSingle<{ status: string }>(
        pool,
        `SELECT o.status FROM stripe._sync_obj_runs o
         JOIN stripe._sync_runs r ON o._account_id = r._account_id AND o.run_started_at = r.started_at
         WHERE o._account_id = '${accountId}' AND o.object = 'subscription_item_change_events_v2_beta'
         ORDER BY r.started_at DESC LIMIT 1`
      )
      expect(siceStatus?.status).toBe('complete')

      const exchangeStatus = await queryDbSingle<{ status: string }>(
        pool,
        `SELECT o.status FROM stripe._sync_obj_runs o
         JOIN stripe._sync_runs r ON o._account_id = r._account_id AND o.run_started_at = r.started_at
         WHERE o._account_id = '${accountId}' AND o.object = 'exchange_rates_from_usd'
         ORDER BY r.started_at DESC LIMIT 1`
      )
      expect(exchangeStatus?.status).toBe('complete')
    }
  })
})
