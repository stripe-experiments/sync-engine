/**
 * Webhook Reuse E2E Test
 * Tests that findOrCreateManagedWebhook correctly reuses existing webhooks
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import pg from 'pg'
import { startPostgres, stopPostgres, getDatabaseUrl } from './helpers/test-db.js'
import { checkEnvVars, getStripeClient } from './helpers/stripe-client.js'
import { StripeSync, runMigrations } from '../index.js'

const CONTAINER_NAME = 'stripe-sync-webhook-reuse-test'
const DB_NAME = 'app_db'
const PORT = 5439

describe('Webhook Reuse E2E', () => {
  let pool: pg.Pool
  let sync: StripeSync
  const createdWebhookIds: string[] = []

  beforeAll(async () => {
    checkEnvVars('STRIPE_API_KEY')

    // Start PostgreSQL
    pool = await startPostgres({ containerName: CONTAINER_NAME, dbName: DB_NAME, port: PORT })

    // Run migrations
    await runMigrations({ databaseUrl: getDatabaseUrl(PORT, DB_NAME) })

    // Create StripeSync instance
    sync = new StripeSync({
      databaseUrl: getDatabaseUrl(PORT, DB_NAME),
      stripeSecretKey: process.env.STRIPE_API_KEY!,
    })
  }, 60000)

  afterAll(async () => {
    // Cleanup created webhooks
    for (const id of createdWebhookIds) {
      try {
        await sync.deleteManagedWebhook(id)
      } catch {
        // Ignore errors during cleanup
      }
    }

    // Close sync pool
    await sync?.postgresClient?.pool?.end()

    // Close pool and stop PostgreSQL
    await pool?.end()
    await stopPostgres(CONTAINER_NAME)
  }, 30000)

  it('should create initial webhook', async () => {
    const webhook = await sync.findOrCreateManagedWebhook(
      'https://test1.example.com/stripe-webhooks',
      { enabled_events: ['*'] }
    )

    expect(webhook.id).toMatch(/^we_/)
    createdWebhookIds.push(webhook.id)

    // Verify webhook count
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const webhooks = await (sync as any).listManagedWebhooks()
    expect(webhooks.length).toBe(1)
  })

  it('should reuse existing webhook with same base URL', async () => {
    const webhook1 = await sync.findOrCreateManagedWebhook(
      'https://test1.example.com/stripe-webhooks',
      { enabled_events: ['*'] }
    )

    const webhook2 = await sync.findOrCreateManagedWebhook(
      'https://test1.example.com/stripe-webhooks',
      { enabled_events: ['*'] }
    )

    expect(webhook2.id).toBe(webhook1.id)

    // Verify still only one webhook
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const webhooks = await (sync as any).listManagedWebhooks()
    expect(webhooks.length).toBe(1)
  })

  it('should create new webhook for different base URL', async () => {
    const webhook1 = await sync.findOrCreateManagedWebhook(
      'https://test1.example.com/stripe-webhooks',
      { enabled_events: ['*'] }
    )

    const webhook2 = await sync.findOrCreateManagedWebhook(
      'https://test2.example.com/stripe-webhooks',
      { enabled_events: ['*'] }
    )
    createdWebhookIds.push(webhook2.id)

    expect(webhook2.id).not.toBe(webhook1.id)
  })

  it('should handle orphaned webhook cleanup', async () => {
    const stripe = getStripeClient()

    // Create a webhook
    const webhook = await sync.findOrCreateManagedWebhook(
      'https://test3.example.com/stripe-webhooks',
      { enabled_events: ['*'] }
    )
    const orphanedId = webhook.id
    createdWebhookIds.push(orphanedId)

    // Delete from database only (simulate orphaned state)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (sync as any).postgresClient.query(`DELETE FROM stripe._managed_webhooks WHERE id = $1`, [
      orphanedId,
    ])

    // Call again - should clean up orphan and create new one
    const newWebhook = await sync.findOrCreateManagedWebhook(
      'https://test3.example.com/stripe-webhooks',
      { enabled_events: ['*'] }
    )
    createdWebhookIds.push(newWebhook.id)

    expect(newWebhook.id).not.toBe(orphanedId)

    // Verify orphaned webhook was actually deleted from Stripe
    try {
      await stripe.webhookEndpoints.retrieve(orphanedId)
      // If we get here, the webhook still exists - fail the test
      expect.fail('Orphaned webhook should have been deleted from Stripe')
    } catch (err: unknown) {
      const stripeError = err as { code?: string; type?: string }
      expect(stripeError.code).toBe('resource_missing')
    }
  })

  it('should handle concurrent execution without duplicates', async () => {
    const concurrentUrl = 'https://test-concurrent.example.com/stripe-webhooks'

    // Create 5 concurrent requests
    const promises = Array(5)
      .fill(null)
      .map(() => sync.findOrCreateManagedWebhook(concurrentUrl, { enabled_events: ['*'] }))

    const results = await Promise.all(promises)

    // All should return the same ID
    const uniqueIds = new Set(results.map((w) => w.id))
    expect(uniqueIds.size).toBe(1)

    createdWebhookIds.push(results[0].id)

    // Verify only one webhook in database
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const webhooks = await (sync as any).listManagedWebhooks()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const matching = webhooks.filter((w: any) => w.url === concurrentUrl)
    expect(matching.length).toBe(1)
  })

  it('should isolate webhooks per account (if STRIPE_API_KEY_2 available)', async () => {
    const key2 = process.env.STRIPE_API_KEY_2
    if (!key2) {
      console.log('Skipping multi-account test: STRIPE_API_KEY_2 not set')
      return
    }

    // Create second StripeSync instance
    const sync2 = new StripeSync({
      databaseUrl: getDatabaseUrl(PORT, DB_NAME),
      stripeSecretKey: key2,
    })

    const sharedUrl = 'https://test-shared.example.com/stripe-webhooks'

    const webhook1 = await sync.findOrCreateManagedWebhook(sharedUrl, {
      enabled_events: ['*'],
    })
    createdWebhookIds.push(webhook1.id)

    const webhook2 = await sync2.findOrCreateManagedWebhook(sharedUrl, {
      enabled_events: ['*'],
    })

    // Each account should have its own webhook
    expect(webhook2.id).not.toBe(webhook1.id)

    // Cleanup
    try {
      await sync2.deleteManagedWebhook(webhook2.id)
    } catch {
      // Ignore
    }

    await sync2.postgresClient?.pool?.end()
  })
})
