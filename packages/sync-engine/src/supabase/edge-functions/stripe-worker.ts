/**
 * Stripe Sync Worker
 *
 * Triggered by pg_cron at a configurable interval (default: 60 seconds).
 *
 * Flow:
 *
 * Concurrency:
 */

import { StripeSync, StripeSyncWorker, getTableName } from 'npm:stripe-experiment-sync'
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
const tableNames = objects.map((obj) => getTableName(obj, stripeSync.resourceRegistry))

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

  const runKey = await stripeSync.postgresClient.joinOrCreateSyncRun(
    stripeSync.accountId,
    'stripe-worker',
    tableNames
  )

  const worker = new StripeSyncWorker(
    stripeSync.stripe,
    stripeSync.config,
    stripeSync.sigma,
    stripeSync.postgresClient,
    stripeSync.accountId,
    stripeSync.resourceRegistry,
    runKey,
    1
  )
  worker.start()
  await worker.waitUntilDone()

  const totals = await stripeSync.postgresClient.getObjectSyncedCounts(
    stripeSync.accountId,
    runKey.runStartedAt
  )

  return new Response(JSON.stringify({ totals }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
})
