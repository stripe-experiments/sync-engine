/**
 * Account Management E2E Test
 * Tests getCurrentAccount(), getAllSyncedAccounts(), and dangerouslyDeleteSyncedAccountData()
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
import { checkEnvVars } from './helpers/stripe-client.js'
import { buildCli, runCliCommand } from './helpers/cli-process.js'
import { StripeSync } from '../index.js'

const CONTAINER_NAME = 'stripe-sync-test-account-mgmt'
const DB_NAME = 'app_db'
const PORT = 5436

describe('Account Management E2E', () => {
  let pool: pg.Pool
  let sync: StripeSync
  const cwd = process.cwd()
  let accountId: string

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
    sync = new StripeSync({
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
      // Backfill existing products from Stripe account (no write permissions needed)
      runCliCommand('backfill', ['product'], {
        cwd,
        env: { DATABASE_URL: getDatabaseUrl(PORT, DB_NAME) },
      })
    }, 120000)

    it('should preview deletion with dry-run (no actual deletion)', async () => {
      const productsBefore = await queryDbCount(
        pool,
        `SELECT COUNT(*) FROM stripe.products WHERE _account_id = '${accountId}'`
      )
      // Account should have at least some products
      expect(productsBefore).toBeGreaterThan(0)

      // Run dry-run deletion
      const result = await sync.dangerouslyDeleteSyncedAccountData(accountId, { dryRun: true })
      // API returns { deletedAccountId, deletedRecordCounts, warnings }
      expect(result.deletedAccountId).toBe(accountId)
      expect(result.deletedRecordCounts).toBeDefined()
      expect(result.deletedRecordCounts.products).toBe(productsBefore)

      // Verify no actual deletion occurred (dry-run)
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
      const accountsBefore = await queryDbCount(
        pool,
        `SELECT COUNT(*) FROM stripe.accounts WHERE id = '${accountId}'`
      )

      // Perform actual deletion
      const result = await sync.dangerouslyDeleteSyncedAccountData(accountId, { dryRun: false })
      expect(result.deletedAccountId).toBe(accountId)
      expect(result.deletedRecordCounts.products).toBe(productsBefore)
      expect(result.deletedRecordCounts.accounts).toBe(accountsBefore)

      // Verify cascade deletion
      const productsAfter = await queryDbCount(
        pool,
        `SELECT COUNT(*) FROM stripe.products WHERE _account_id = '${accountId}'`
      )
      expect(productsAfter).toBe(0)

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
      expect(result.deletedRecordCounts.accounts).toBe(0)
    })
  })
})
