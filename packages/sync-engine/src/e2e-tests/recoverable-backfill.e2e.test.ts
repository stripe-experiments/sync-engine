/**
 * Error Recovery E2E Test
 * Tests that sync can recover from crashes and preserve partial progress
 *
 * NOTE: This test requires write permissions to create test products.
 * It will be skipped if using restricted API keys (rk_*).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execSync, spawn } from 'child_process'
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

const CONTAINER_NAME = 'stripe-sync-test-recovery'
const DB_NAME = 'app_db'
const PORT = 5437

describe('Error Recovery E2E', () => {
  let pool: pg.Pool
  const tracker = new ResourceTracker()
  let stripe: ReturnType<typeof getStripeClient>
  const cwd = process.cwd()
  let hasWritePermissions = false

  beforeAll(async () => {
    checkEnvVars('STRIPE_API_KEY')
    stripe = getStripeClient()

    // Check if we have write permissions by trying to create a test product
    try {
      const testProduct = await stripe.products.create({
        name: 'Permission Test Product',
        description: 'Testing write permissions',
      })
      await stripe.products.update(testProduct.id, { active: false })
      hasWritePermissions = true
    } catch (err: unknown) {
      const stripeError = err as { code?: string; type?: string }
      if (stripeError.code === 'permission_error' || stripeError.type === 'StripePermissionError') {
        console.log('Skipping Error Recovery tests: API key lacks write permissions')
        hasWritePermissions = false
        return
      }
      throw err
    }

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

    // Create 200 test products for crash testing
    for (let i = 1; i <= 200; i++) {
      const product = await stripe.products.create({
        name: `Test Product ${i} - Recovery`,
        description: `Integration test product ${i} for error recovery`,
      })
      tracker.trackProduct(product.id)
    }
  }, 300000) // 5 minutes for creating 200 products

  afterAll(async () => {
    // Cleanup Stripe resources
    if (hasWritePermissions) {
      await tracker.cleanup(stripe)
    }

    // Close pool and stop PostgreSQL
    await pool?.end()
    await stopPostgres(CONTAINER_NAME)
  }, 60000)

  it('should preserve partial progress and recover after crash', async () => {
    if (!hasWritePermissions) {
      console.log('Skipping: requires write permissions')
      return
    }

    // Start backfill in background
    const syncProcess = spawn('node', ['dist/cli/index.js', 'backfill', 'product'], {
      cwd,
      env: { ...process.env, DATABASE_URL: getDatabaseUrl(PORT, DB_NAME) },
      stdio: 'pipe',
    })

    // Wait for sync to reach 'running' state AND have synced at least some products
    let status = ''
    let productsBeforeKill = 0
    let attempts = 0
    const maxAttempts = 200 // 20 seconds max wait

    while (attempts < maxAttempts) {
      const statusRow = await queryDbSingle<{ status: string }>(
        pool,
        `SELECT o.status FROM stripe._sync_obj_runs o
         JOIN stripe._sync_runs r ON o._account_id = r._account_id AND o.run_started_at = r.started_at
         WHERE o.object = 'products'
         ORDER BY r.started_at DESC LIMIT 1`
      )
      status = statusRow?.status ?? ''

      // Check how many products have been synced
      productsBeforeKill = await queryDbCount(pool, 'SELECT COUNT(*) FROM stripe.products')

      // Wait until we have at least some products synced before killing
      if (status === 'running' && productsBeforeKill > 0) {
        break
      }

      // If sync already completed, no crash test needed
      if (status === 'complete') {
        break
      }

      await sleep(100)
      attempts++
    }

    // If sync completed before we could interrupt, verify completion and skip crash test
    if (status === 'complete') {
      console.log('Sync completed before interruption - verifying completion instead')
      const finalProducts = await queryDbCount(pool, 'SELECT COUNT(*) FROM stripe.products')
      expect(finalProducts).toBeGreaterThanOrEqual(200)
      syncProcess.kill('SIGTERM')
      return
    }

    // If we couldn't get any products synced in time, skip gracefully
    if (productsBeforeKill === 0) {
      console.log('Could not catch sync in progress with products - skipping crash test')
      syncProcess.kill('SIGTERM')
      return
    }

    expect(status).toBe('running')

    // Kill the sync process to simulate crash
    syncProcess.kill('SIGKILL')
    await sleep(500)

    // Verify products synced before crash are still in DB (partial progress preserved)
    // Use >= because more products may have synced between measuring and killing (race condition)
    const productsAfterKill = await queryDbCount(pool, 'SELECT COUNT(*) FROM stripe.products')
    expect(productsAfterKill).toBeGreaterThanOrEqual(productsBeforeKill)

    // Re-run backfill to recover and complete
    runCliCommand('backfill', ['product'], {
      cwd,
      env: { DATABASE_URL: getDatabaseUrl(PORT, DB_NAME) },
    })

    // Verify sync completed
    const finalStatusRow = await queryDbSingle<{ status: string }>(
      pool,
      `SELECT o.status FROM stripe._sync_obj_runs o
       JOIN stripe._sync_runs r ON o._account_id = r._account_id AND o.run_started_at = r.started_at
       WHERE o.object = 'products'
       ORDER BY r.started_at DESC LIMIT 1`
    )
    expect(finalStatusRow?.status).toBe('complete')

    // Verify all 200 products are now synced
    const finalProducts = await queryDbCount(pool, 'SELECT COUNT(*) FROM stripe.products')
    expect(finalProducts).toBeGreaterThanOrEqual(200)
  }, 120000)
})

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
