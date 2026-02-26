/**
 * Sync Run Lifecycle E2E Test
 * Verifies sync_runs view and _sync_runs table stay in sync
 * Tests that object runs are created upfront to prevent premature close
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execSync } from 'child_process'
import pg from 'pg'
import { startPostgres, stopPostgres, getDatabaseUrl } from './helpers/test-db.js'
import { checkEnvVars } from './helpers/stripe-client.js'
import { buildCli } from './helpers/cli-process.js'
import { StripeSync, getTableName } from '../../index.js'

const CONTAINER_NAME = 'stripe-sync-lifecycle-test'
const DB_NAME = 'app_db'
const PORT = 5435

describe('Sync Run Lifecycle E2E', () => {
  let pool: pg.Pool
  let sync: StripeSync
  const cwd = process.cwd()

  beforeAll(async () => {
    checkEnvVars('STRIPE_API_KEY')

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

    // Create StripeSync instance
    sync = await StripeSync.create({
      databaseUrl: getDatabaseUrl(PORT, DB_NAME),
      stripeSecretKey: process.env.STRIPE_API_KEY!,
    })
  }, 60000)

  afterAll(async () => {
    // Close sync pool
    await sync?.postgresClient?.pool?.end()

    // Close pool and stop PostgreSQL
    await pool?.end()
    await stopPostgres(CONTAINER_NAME)
  }, 30000)

  /** Helper: get resource (table) names for all supported sync objects */
  function getResourceNames(): string[] {
    const objects = sync.getSupportedSyncObjects()
    return objects.map((obj) => getTableName(obj, sync.resourceRegistry))
  }

  it('should create object runs upfront (prevents premature close)', async () => {
    const resourceNames = getResourceNames()

    // Create sync run via postgresClient
    const runKey = await sync.postgresClient.joinOrCreateSyncRun(
      sync.accountId,
      'test',
      resourceNames
    )

    // Check object runs were created upfront
    const result = await sync.postgresClient.pool.query(
      `SELECT COUNT(*) as count FROM stripe._sync_obj_runs
       WHERE "_account_id" = $1 AND run_started_at = $2`,
      [runKey.accountId, runKey.runStartedAt]
    )
    const objectRunCount = parseInt(result.rows[0].count, 10)

    expect(objectRunCount).toBe(resourceNames.length)
  })

  it('should match sync_runs view with _sync_runs table', async () => {
    const resourceNames = getResourceNames()
    const runKey = await sync.postgresClient.joinOrCreateSyncRun(
      sync.accountId,
      'test-view-sync',
      resourceNames
    )

    // Get active run via StripeSync method
    const activeRun = await sync.postgresClient.getActiveSyncRun(runKey.accountId)
    expect(activeRun).not.toBeNull()
    // Use tolerance for timestamp comparison (database precision may differ slightly)
    const timeDiff = Math.abs(activeRun!.runStartedAt.getTime() - runKey.runStartedAt.getTime())
    expect(timeDiff).toBeLessThanOrEqual(100) // Allow 100ms tolerance

    // Check view vs table
    const viewResult = await sync.postgresClient.pool.query(
      `SELECT closed_at, status, total_objects FROM stripe.sync_runs
       WHERE account_id = $1 AND started_at = $2`,
      [runKey.accountId, runKey.runStartedAt]
    )
    const tableResult = await sync.postgresClient.pool.query(
      `SELECT closed_at FROM stripe._sync_runs
       WHERE "_account_id" = $1 AND started_at = $2`,
      [runKey.accountId, runKey.runStartedAt]
    )

    const viewData = viewResult.rows[0]
    const tableData = tableResult.rows[0]

    // Both should have null closed_at (run is active)
    expect(viewData.closed_at === null).toBe(tableData.closed_at === null)
  })

  it('should keep run open after first object completes (no premature close)', async () => {
    const resourceNames = getResourceNames()
    expect(resourceNames.length).toBeGreaterThan(1)

    const runKey = await sync.postgresClient.joinOrCreateSyncRun(
      sync.accountId,
      'test-premature-close',
      resourceNames
    )

    // Complete the first object directly via postgresClient
    await sync.postgresClient.tryStartObjectSync(
      runKey.accountId,
      runKey.runStartedAt,
      resourceNames[0]
    )
    await sync.postgresClient.completeObjectSync(
      runKey.accountId,
      runKey.runStartedAt,
      resourceNames[0]
    )

    // Check state after first object
    const afterFirstResult = await sync.postgresClient.pool.query(
      `SELECT closed_at, complete_count, total_objects, pending_count FROM stripe.sync_runs
       WHERE account_id = $1 AND started_at = $2`,
      [runKey.accountId, runKey.runStartedAt]
    )
    const afterFirst = afterFirstResult.rows[0]

    const completeCount = parseInt(afterFirst.complete_count, 10)
    const totalObjects = parseInt(afterFirst.total_objects, 10)

    expect(completeCount).toBe(1)
    expect(totalObjects).toBe(resourceNames.length)
    expect(afterFirst.closed_at).toBeNull() // Run should NOT close prematurely
  })

  it('should close run properly after all objects complete', async () => {
    const resourceNames = getResourceNames()
    const runKey = await sync.postgresClient.joinOrCreateSyncRun(
      sync.accountId,
      'test-complete',
      resourceNames
    )

    // Complete all objects via postgresClient
    for (const obj of resourceNames) {
      await sync.postgresClient.tryStartObjectSync(runKey.accountId, runKey.runStartedAt, obj)
      await sync.postgresClient.completeObjectSync(runKey.accountId, runKey.runStartedAt, obj)
    }

    // Check final state
    const finalResult = await sync.postgresClient.pool.query(
      `SELECT closed_at, status, complete_count, total_objects, pending_count FROM stripe.sync_runs
       WHERE account_id = $1 AND started_at = $2`,
      [runKey.accountId, runKey.runStartedAt]
    )
    const finalState = finalResult.rows[0]

    const finalCompleteCount = parseInt(finalState.complete_count, 10)
    const finalPendingCount = parseInt(finalState.pending_count, 10)

    expect(finalState.closed_at).not.toBeNull()
    expect(finalState.status).toBe('complete')
    expect(finalCompleteCount).toBe(resourceNames.length)
    expect(finalPendingCount).toBe(0)

    // Verify table is in sync
    const tableResult = await sync.postgresClient.pool.query(
      `SELECT closed_at FROM stripe._sync_runs
       WHERE "_account_id" = $1 AND started_at = $2`,
      [runKey.accountId, runKey.runStartedAt]
    )
    expect(tableResult.rows[0].closed_at).not.toBeNull()
  })

  it('should isolate multiple runs without interference', async () => {
    const resourceNames = getResourceNames()

    // Create first run and complete it
    const runKey1 = await sync.postgresClient.joinOrCreateSyncRun(
      sync.accountId,
      'test-isolation-1',
      resourceNames
    )

    for (const obj of resourceNames) {
      await sync.postgresClient.tryStartObjectSync(runKey1.accountId, runKey1.runStartedAt, obj)
      await sync.postgresClient.completeObjectSync(runKey1.accountId, runKey1.runStartedAt, obj)
    }

    // Create second run
    const runKey2 = await sync.postgresClient.joinOrCreateSyncRun(
      sync.accountId,
      'test-isolation-2',
      resourceNames
    )

    // Verify different timestamps
    expect(runKey2.runStartedAt.getTime()).not.toBe(runKey1.runStartedAt.getTime())

    // Verify object runs created for new run
    const run2ObjectsResult = await sync.postgresClient.pool.query(
      `SELECT COUNT(*) as count FROM stripe._sync_obj_runs
       WHERE "_account_id" = $1 AND run_started_at = $2`,
      [runKey2.accountId, runKey2.runStartedAt]
    )
    expect(parseInt(run2ObjectsResult.rows[0].count, 10)).toBe(resourceNames.length)

    // Verify first run still shows as complete
    const run1Check = await sync.postgresClient.pool.query(
      `SELECT closed_at, status FROM stripe.sync_runs
       WHERE account_id = $1 AND started_at = $2`,
      [runKey1.accountId, runKey1.runStartedAt]
    )
    expect(run1Check.rows[0].closed_at).not.toBeNull()
    expect(run1Check.rows[0].status).toBe('complete')

    // Both runs should be visible
    const allRunsResult = await sync.postgresClient.pool.query(
      `SELECT account_id, started_at, status FROM stripe.sync_runs
       WHERE account_id = $1
       ORDER BY started_at`,
      [runKey1.accountId]
    )
    expect(allRunsResult.rows.length).toBeGreaterThanOrEqual(2)
  })
})
