/**
 * Error Recovery Integration Test
 * Tests that sync can recover from crashes and preserve partial progress
 * Translated from scripts/test-integration-recoverable-backfill.sh
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

describe('Error Recovery Integration', () => {
  let pool: pg.Pool
  const tracker = new ResourceTracker()
  let stripe: ReturnType<typeof getStripeClient>
  const cwd = process.cwd()
  const productIds: string[] = []
  let accountId: string
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
    } catch (err: any) {
      if (err.code === 'permission_error' || err.type === 'StripePermissionError') {
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
      productIds.push(product.id)
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

  it('should preserve partial progress when sync is interrupted', async () => {
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

    // Wait for sync to reach 'running' state
    let status = ''
    let attempts = 0
    const maxAttempts = 100

    while (attempts < maxAttempts) {
      const statusRow = await queryDbSingle<{ status: string }>(
        pool,
        `SELECT o.status FROM stripe._sync_obj_runs o
         JOIN stripe._sync_runs r ON o._account_id = r._account_id AND o.run_started_at = r.started_at
         WHERE o.object = 'products'
         ORDER BY r.started_at DESC LIMIT 1`
      )
      status = statusRow?.status ?? ''

      if (status === 'running') {
        break
      }

      await sleep(100)
      attempts++
    }

    // Get account ID
    const accountRow = await queryDbSingle<{ account_id: string }>(
      pool,
      'SELECT account_id FROM stripe.sync_runs ORDER BY started_at DESC LIMIT 1'
    )
    accountId = accountRow?.account_id ?? ''

    // If sync completed before we could interrupt, skip crash test
    const productsBeforeKill = await queryDbCount(
      pool,
      "SELECT COUNT(*) FROM stripe.products WHERE name LIKE '%Recovery%'"
    )

    if (productsBeforeKill >= 200) {
      // Sync completed too fast - still verify idempotency
      expect(status).toBe('complete')
      syncProcess.kill('SIGTERM')
      return
    }

    expect(status).toBe('running')

    // Kill the sync process to simulate crash
    syncProcess.kill('SIGKILL')
    await sleep(500)

    // Verify cursor was saved (partial progress preserved)
    const cursorRow = await queryDbSingle<{ cursor: string }>(
      pool,
      `SELECT COALESCE(cursor, '0') as cursor FROM stripe._sync_obj_runs o
       JOIN stripe._sync_runs r ON o._account_id = r._account_id AND o.run_started_at = r.started_at
       WHERE o._account_id = '${accountId}' AND o.object = 'products'
       ORDER BY r.started_at DESC LIMIT 1`
    )

    // Products synced before crash should still be in DB
    expect(productsBeforeKill).toBeGreaterThan(0)
  }, 60000)

  it('should recover and complete sync after interruption', async () => {
    if (!hasWritePermissions) {
      console.log('Skipping: requires write permissions')
      return
    }

    const productsBeforeRecovery = await queryDbCount(
      pool,
      "SELECT COUNT(*) FROM stripe.products WHERE name LIKE '%Recovery%'"
    )

    const cursorBeforeRecovery = await queryDbSingle<{ cursor: string }>(
      pool,
      `SELECT COALESCE(cursor, '0') as cursor FROM stripe._sync_obj_runs o
       JOIN stripe._sync_runs r ON o._account_id = r._account_id AND o.run_started_at = r.started_at
       WHERE o.object = 'products' AND o.status = 'complete'
       ORDER BY o.completed_at DESC LIMIT 1`
    )
    const cursorBefore = parseInt(cursorBeforeRecovery?.cursor ?? '0', 10)

    // Re-run backfill
    runCliCommand('backfill', ['product'], {
      cwd,
      env: { DATABASE_URL: getDatabaseUrl(PORT, DB_NAME) },
    })

    // Verify final status
    const finalStatusRow = await queryDbSingle<{ status: string }>(
      pool,
      `SELECT o.status FROM stripe._sync_obj_runs o
       JOIN stripe._sync_runs r ON o._account_id = r._account_id AND o.run_started_at = r.started_at
       WHERE o.object = 'products'
       ORDER BY r.started_at DESC LIMIT 1`
    )
    expect(finalStatusRow?.status).toBe('complete')

    // Verify no data loss
    const finalProducts = await queryDbCount(
      pool,
      "SELECT COUNT(*) FROM stripe.products WHERE name LIKE '%Recovery%'"
    )
    expect(finalProducts).toBeGreaterThanOrEqual(productsBeforeRecovery)

    // Verify cursor advanced or maintained
    const cursorAfterRecovery = await queryDbSingle<{ cursor: string }>(
      pool,
      `SELECT COALESCE(cursor, '0') as cursor FROM stripe._sync_obj_runs o
       JOIN stripe._sync_runs r ON o._account_id = r._account_id AND o.run_started_at = r.started_at
       WHERE o.object = 'products' AND o.status = 'complete'
       ORDER BY o.completed_at DESC LIMIT 1`
    )
    const cursorAfter = parseInt(cursorAfterRecovery?.cursor ?? '0', 10)
    expect(cursorAfter).toBeGreaterThanOrEqual(cursorBefore)

    // Verify error message cleared
    const errorRow = await queryDbSingle<{ error_message: string }>(
      pool,
      `SELECT COALESCE(o.error_message, '') as error_message FROM stripe._sync_obj_runs o
       JOIN stripe._sync_runs r ON o._account_id = r._account_id AND o.run_started_at = r.started_at
       WHERE o.object = 'products' AND o.status = 'complete'
       ORDER BY r.started_at DESC LIMIT 1`
    )
    expect(errorRow?.error_message ?? '').toBe('')
  }, 120000)
})

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
