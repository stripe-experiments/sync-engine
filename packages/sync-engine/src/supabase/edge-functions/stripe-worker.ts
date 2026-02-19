/**
 * Stripe Sync Worker
 *
 * Triggered by pg_cron at a configurable interval (default: 60 seconds).
 *
 * Flow:
 *
 * Concurrency:
 */

import { StripeSync, StripeSyncWorker, getTableName } from '../../index'
import postgres from 'npm:postgres'

// Reuse these between requests
const rawDbUrl = Deno.env.get('SUPABASE_DB_URL')
const dbUrl = rawDbUrl.replace(/[?&]sslmode=[^&]*/g, '').replace(/[?&]$/, '')
const sql = postgres(dbUrl, { max: 1, prepare: false })
const stripeSync = await StripeSync.create({
  poolConfig: { connectionString: dbUrl, max: 1 },
  stripeSecretKey: Deno.env.get('STRIPE_SECRET_KEY')!,
  enableSigma: (Deno.env.get('ENABLE_SIGMA') ?? 'false') === 'true',
  partnerId: 'pp_supabase',
})
const objects = stripeSync.getSupportedSyncObjects()
const tableNames = objects.map((obj) => stripeSync.resourceRegistry[obj].tableName)
const interval = Deno.env.get('INTERVAL') | (60 * 60 * 24)

Deno.serve(async (req) => {
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return new Response('Unauthorized', { status: 401 })
  }

  const token = authHeader.substring(7) // Remove 'Bearer '

  // Validate that the token matches the unique worker secret stored in vault
  const vaultResult = await sql`
    SELECT decrypted_secret
    FROM vault.decrypted_secrets
    WHERE name = 'stripe_sync_worker_secret'
  `

  if (vaultResult.length === 0) {
    return new Response('Worker secret not configured in vault', { status: 500 })
  }
  const storedSecret = vaultResult[0].decrypted_secret
  if (token !== storedSecret) {
    return new Response('Forbidden: Invalid worker secret', { status: 403 })
  }

  const runKey = await stripeSync.postgresClient.reconciliationRun(
    stripeSync.accountId,
    'stripe-worker',
    tableNames,
    interval
  )
  if (runKey === null) {
    const completedRun = await stripeSync.postgresClient.getCompletedRun(
      stripeSync.accountId,
      interval
    )
    const response = `✓ Skipping resync — a successful run completed at ${completedRun?.runStartedAt.toISOString()} (within ${interval}s window)`
    console.log(response)
    return new Response(response, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  console.log('accountId: ', runKey.accountId)
  await stripeSync.postgresClient.resetStuckRunningObjects(runKey.accountId, runKey.runStartedAt, 1)

  const workerCount = 10
  const workers = Array.from(
    { length: workerCount },
    () =>
      new StripeSyncWorker(
        stripeSync.stripe,
        stripeSync.config,
        stripeSync.sigma,
        stripeSync.postgresClient,
        stripeSync.accountId,
        stripeSync.resourceRegistry,
        runKey,
        stripeSync.upsertAny.bind(stripeSync)
      )
  )
  const MAX_EXECUTION_MS = 50_000 // edge function limit
  workers.forEach((worker) => worker.start())
  await Promise.race([
    Promise.all(workers.map((w) => w.waitUntilDone())),
    new Promise((resolve) => setTimeout(resolve, MAX_EXECUTION_MS)),
  ])
  workers.forEach((w) => w.shutdown())
  console.log("Finished after 50s")
  const totals = await stripeSync.postgresClient.getObjectSyncedCounts(
    stripeSync.accountId,
    runKey.runStartedAt
  )

  return new Response(JSON.stringify({ totals }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
})
