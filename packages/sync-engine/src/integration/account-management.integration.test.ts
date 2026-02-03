/**
 * Account Management Integration Test
 * Tests getCurrentAccount(), getAllSyncedAccounts(), and dangerouslyDeleteSyncedAccountData()
 * Translated from scripts/test-integration-account-management.sh
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execSync } from 'child_process'
import pg from 'pg'
import {
  startPostgres,
  stopPostgres,
  queryDb,
  queryDbCount,
  queryDbSingle,
  getDatabaseUrl,
} from './helpers/test-db.js'
import { getStripeClient, checkEnvVars } from './helpers/stripe-client.js'
import { ResourceTracker } from './helpers/cleanup.js'
import { buildCli, runCliCommand } from './helpers/cli-process.js'
import { StripeSync } from '../index.js'

const CONTAINER_NAME = 'stripe-sync-test-account-mgmt'
const DB_NAME = 'app_db'
const PORT = 5436

describe('Account Management Integration', () => {
  let pool: pg.Pool
  let sync: StripeSync
  let stripe: ReturnType<typeof getStripeClient>
  const tracker = new ResourceTracker()
  const cwd = process.cwd()

  // Store created resource IDs
  const productIds: string[] = []
  const customerIds: string[] = []
  let accountId: string

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

    // Create StripeSync instance
    sync = new StripeSync({
      databaseUrl: getDatabaseUrl(PORT, DB_NAME),
      stripeSecretKey: process.env.STRIPE_API_KEY!,
    })
  }, 60000)

  afterAll(async () => {
    // Cleanup Stripe resources
    await tracker.cleanup(stripe)

    // Close sync pool
    await sync?.postgresClient?.pool?.end()

    // Close pool and stop PostgreSQL
    await pool?.end()
    await stopPostgres(CONTAINER_NAME)
  }, 30000)

  describe('getCurrentAccount()', () => {
    it('should fetch and persist account to database', async () => {
      // Fetch account
      const account = await sync.getCurrentAccount()
      expect(account).not.toBeNull()
      expect(account!.id).toMatch(/^acct_/)
      accountId = account!.id

      // Verify persisted to database
      const dbCount = await queryDbCount(
        pool,
        `SELECT COUNT(*) FROM stripe.accounts WHERE id = '${accountId}'`
      )
      expect(dbCount).toBe(1)
    })

    it('should have raw_data column populated', async () => {
      const row = await queryDbSingle<{ _raw_data: object }>(
        pool,
        `SELECT _raw_data FROM stripe.accounts WHERE id = '${accountId}'`
      )
      expect(row).not.toBeNull()
      expect(row!._raw_data).not.toBeNull()
    })
  })

  describe('getAllSyncedAccounts()', () => {
    it('should retrieve synced accounts from database', async () => {
      const accounts = await sync.getAllSyncedAccounts()
      expect(accounts.length).toBeGreaterThanOrEqual(1)
      expect(accounts[0].id).toMatch(/^acct_/)
    })

    it('should order accounts by last synced', async () => {
      const accounts = await sync.getAllSyncedAccounts()
      const firstAccount = accounts[0]
      expect(firstAccount.id).toBe(accountId)
    })
  })

  describe('dangerouslyDeleteSyncedAccountData()', () => {
    beforeAll(async () => {
      // Create test data in Stripe
      // Create 10 test products
      for (let i = 1; i <= 10; i++) {
        const product = await stripe.products.create({
          name: `Test Product ${i} - AccountMgmt`,
          description: `Test product ${i} for account management testing`,
        })
        productIds.push(product.id)
        tracker.trackProduct(product.id)
      }

      // Create 5 test customers
      for (let i = 1; i <= 5; i++) {
        const customer = await stripe.customers.create({
          name: `Test Customer ${i}`,
          email: `test${i}@example.com`,
        })
        customerIds.push(customer.id)
        tracker.trackCustomer(customer.id)
      }

      // Sync test data to database
      runCliCommand('backfill', ['product'], {
        cwd,
        env: { DATABASE_URL: getDatabaseUrl(PORT, DB_NAME) },
      })
      runCliCommand('backfill', ['customer'], {
        cwd,
        env: { DATABASE_URL: getDatabaseUrl(PORT, DB_NAME) },
      })
    }, 120000)

    it('should preview deletion with dry-run (no actual deletion)', async () => {
      const productsBefore = await queryDbCount(
        pool,
        `SELECT COUNT(*) FROM stripe.products WHERE _account_id = '${accountId}'`
      )
      expect(productsBefore).toBeGreaterThanOrEqual(10)

      const customersBefore = await queryDbCount(
        pool,
        `SELECT COUNT(*) FROM stripe.customers WHERE _account_id = '${accountId}'`
      )
      expect(customersBefore).toBeGreaterThanOrEqual(5)

      // Run dry-run deletion
      const result = await sync.dangerouslyDeleteSyncedAccountData(accountId, { dryRun: true })
      expect(result.dryRun).toBe(true)
      expect(result.deletedCounts.products).toBeGreaterThanOrEqual(10)
      expect(result.deletedCounts.customers).toBeGreaterThanOrEqual(5)

      // Verify no actual deletion occurred
      const productsAfter = await queryDbCount(
        pool,
        `SELECT COUNT(*) FROM stripe.products WHERE _account_id = '${accountId}'`
      )
      expect(productsAfter).toBe(productsBefore)
    })

    it('should delete all synced data for account', async () => {
      const productsBefore = await queryDbCount(
        pool,
        `SELECT COUNT(*) FROM stripe.products WHERE _account_id = '${accountId}'`
      )
      const customersBefore = await queryDbCount(
        pool,
        `SELECT COUNT(*) FROM stripe.customers WHERE _account_id = '${accountId}'`
      )
      const accountsBefore = await queryDbCount(
        pool,
        `SELECT COUNT(*) FROM stripe.accounts WHERE id = '${accountId}'`
      )

      // Perform actual deletion
      const result = await sync.dangerouslyDeleteSyncedAccountData(accountId, { dryRun: false })
      expect(result.dryRun).toBe(false)
      expect(result.deletedCounts.products).toBe(productsBefore)
      expect(result.deletedCounts.customers).toBe(customersBefore)
      expect(result.deletedCounts.accounts).toBe(accountsBefore)

      // Verify cascade deletion
      const productsAfter = await queryDbCount(
        pool,
        `SELECT COUNT(*) FROM stripe.products WHERE _account_id = '${accountId}'`
      )
      expect(productsAfter).toBe(0)

      const customersAfter = await queryDbCount(
        pool,
        `SELECT COUNT(*) FROM stripe.customers WHERE _account_id = '${accountId}'`
      )
      expect(customersAfter).toBe(0)

      const accountsAfter = await queryDbCount(
        pool,
        `SELECT COUNT(*) FROM stripe.accounts WHERE id = '${accountId}'`
      )
      expect(accountsAfter).toBe(0)
    })

    it('should handle non-existent account gracefully', async () => {
      const result = await sync.dangerouslyDeleteSyncedAccountData('acct_nonexistent', {
        dryRun: false,
      })
      expect(result.deletedCounts.accounts).toBe(0)
    })
  })
})
