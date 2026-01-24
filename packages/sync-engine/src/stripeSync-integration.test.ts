import { describe, it, beforeAll, afterAll, beforeEach, vi, expect } from 'vitest'
import { StripeSync, runMigrations } from './index'
import pg from 'pg'

/**
 * Integration tests for StripeSync against a real Postgres database.
 *
 * These tests use a real database connection but mock the Stripe API
 * to test the full sync lifecycle without hitting Stripe.
 *
 * Run with: npm run test:integration
 *
 * Requires: TEST_POSTGRES_DB_URL environment variable pointing to a test database
 * Example: TEST_POSTGRES_DB_URL=postgresql://localhost:5432/stripe_sync_test
 */

// ---------------------------------------------------------------------------
// Test Configuration
// ---------------------------------------------------------------------------

const TEST_DB_URL = process.env.TEST_POSTGRES_DB_URL
const TEST_ACCOUNT_ID = 'acct_test_integration'

// Skip all tests if no database URL is provided
const describeWithDb = TEST_DB_URL ? describe : describe.skip

// ---------------------------------------------------------------------------
// Mock Data Types & Factories
// ---------------------------------------------------------------------------

type MockStripeObject = { id: string; created: number; [key: string]: unknown }

let customerIdCounter = 0
let planIdCounter = 0

export function createMockCustomer(overrides: { id?: string; created?: number } = {}): MockStripeObject {
  customerIdCounter++
  return {
    id: overrides.id ?? `cus_test_${customerIdCounter.toString().padStart(6, '0')}`,
    object: 'customer',
    created: overrides.created ?? Math.floor(Date.now() / 1000) - customerIdCounter,
  }
}

export function createMockPlan(overrides: { id?: string; created?: number } = {}): MockStripeObject {
  planIdCounter++
  return {
    id: overrides.id ?? `plan_test_${planIdCounter.toString().padStart(6, '0')}`,
    object: 'plan',
    created: overrides.created ?? Math.floor(Date.now() / 1000) - planIdCounter,
  }
}

export function createMockCustomerBatch(count: number, startTimestamp?: number): MockStripeObject[] {
  const baseTimestamp = startTimestamp ?? Math.floor(Date.now() / 1000)
  return Array.from({ length: count }, (_, i) => createMockCustomer({ created: baseTimestamp - i }))
}

export function createMockPlanBatch(count: number, startTimestamp?: number): MockStripeObject[] {
  const baseTimestamp = startTimestamp ?? Math.floor(Date.now() / 1000)
  return Array.from({ length: count }, (_, i) => createMockPlan({ created: baseTimestamp - i }))
}

// ---------------------------------------------------------------------------
// Stripe API Mock Helpers
// ---------------------------------------------------------------------------

export function createPaginatedResponse(
  allItems: MockStripeObject[],
  params: { limit?: number; starting_after?: string; created?: { gte?: number } } = {}
): { data: MockStripeObject[]; has_more: boolean; object: 'list' } {
  const limit = params.limit ?? 100

  // Stripe returns items in reverse chronological order (newest first)
  let items = [...allItems].sort((a, b) => b.created - a.created)

  if (params.created?.gte) {
    items = items.filter((item) => item.created >= params.created!.gte!)
  }

  if (params.starting_after) {
    const cursorIndex = items.findIndex((item) => item.id === params.starting_after)
    if (cursorIndex !== -1) {
      items = items.slice(cursorIndex + 1)
    }
  }


  const pageItems = items.slice(0, limit)

  return { data: pageItems, has_more: items.length > limit, object: 'list' }
}

// ---------------------------------------------------------------------------
// Database Validation Helpers
// ---------------------------------------------------------------------------

export class DatabaseValidator {
  private pool: pg.Pool

  constructor(databaseUrl: string) {
    this.pool = new pg.Pool({ connectionString: databaseUrl })
  }

  async getCustomerCount(accountId: string): Promise<number> {
    const result = await this.pool.query('SELECT COUNT(*) as count FROM stripe.customers WHERE _account_id = $1', [accountId])
    return parseInt(result.rows[0].count, 10)
  }

  async getPlanCount(accountId: string): Promise<number> {
    const result = await this.pool.query('SELECT COUNT(*) as count FROM stripe.plans WHERE _account_id = $1', [accountId])
    return parseInt(result.rows[0].count, 10)
  }

  async getCustomerIds(accountId: string): Promise<string[]> {
    const result = await this.pool.query('SELECT id FROM stripe.customers WHERE _account_id = $1 ORDER BY id', [accountId])
    return result.rows.map((row) => row.id)
  }

  async getPlanIds(accountId: string): Promise<string[]> {
    const result = await this.pool.query('SELECT id FROM stripe.plans WHERE _account_id = $1 ORDER BY id', [accountId])
    return result.rows.map((row) => row.id)
  }

  async clearAccountData(accountId: string): Promise<void> {
    await this.pool.query('DELETE FROM stripe.customers WHERE _account_id = $1', [accountId])
    await this.pool.query('DELETE FROM stripe.plans WHERE _account_id = $1', [accountId])
    await this.pool.query('DELETE FROM stripe._sync_obj_runs WHERE _account_id = $1', [accountId])
    await this.pool.query('DELETE FROM stripe._sync_runs WHERE _account_id = $1', [accountId])
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describeWithDb('StripeSync Integration Tests', () => {
  let sync: StripeSync
  let validator: DatabaseValidator

  // Mock data storage - populate these in your tests to control Stripe API responses
  let mockCustomers: MockStripeObject[] = []
  let mockPlans: MockStripeObject[] = []

  beforeAll(async () => {
    if (!TEST_DB_URL) throw new Error('TEST_POSTGRES_DB_URL environment variable is required')
    await runMigrations({ databaseUrl: TEST_DB_URL })
    validator = new DatabaseValidator(TEST_DB_URL)
  })

  afterAll(async () => {
    if (validator) {
      // await validator.clearAccountData(TEST_ACCOUNT_ID)
      await validator.close()
    }
    if (sync) {
      await sync.postgresClient.pool.end()
    }
  })

  beforeEach(async () => {
    customerIdCounter = 0
    planIdCounter = 0
    mockCustomers = []
    mockPlans = []

    if (validator) await validator.clearAccountData(TEST_ACCOUNT_ID)

    sync = new StripeSync({
      stripeSecretKey: 'sk_test_fake_integration',
      databaseUrl: TEST_DB_URL!,
      poolConfig: {},
    })

    // Create test account in database (required for foreign key constraints)
    await sync.postgresClient.upsertAccount({ id: TEST_ACCOUNT_ID, raw_data: { id: TEST_ACCOUNT_ID } }, 'test_hash')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(sync as any).getCurrentAccount = vi.fn().mockResolvedValue({ id: TEST_ACCOUNT_ID })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(sync.stripe as any).customers = {
      list: vi.fn().mockImplementation((params) => Promise.resolve(createPaginatedResponse(mockCustomers, params))),
      retrieve: vi.fn().mockImplementation((id: string) => Promise.resolve(mockCustomers.find((c) => c.id === id) ?? null)),
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(sync.stripe as any).plans = {
      list: vi.fn().mockImplementation((params) => Promise.resolve(createPaginatedResponse(mockPlans, params))),
      retrieve: vi.fn().mockImplementation((id: string) => Promise.resolve(mockPlans.find((p) => p.id === id) ?? null)),
    }
  })
  it('should have validator connected to database', async () => {
    const customerCount = await validator.getCustomerCount(TEST_ACCOUNT_ID)
    expect(customerCount).toBe(0)
  })

  describe('processNext', () => {
    it('should sync historical data by paginating through it', async () => {
      mockCustomers = createMockCustomerBatch(350)
  
      //every run of processNext should add 100 items
      for(let i = 1; i <= 3; i++){
        const syncReturnVal = await sync.processNext('customer');
      
        expect(syncReturnVal.hasMore).toStrictEqual(true);
        expect(syncReturnVal.processed).toStrictEqual(100);

        const countInDb = await validator.getCustomerCount(TEST_ACCOUNT_ID)
        expect(countInDb).toStrictEqual(100 * i);
      }

      const syncReturnVal = await sync.processNext('customer');
    
      expect(syncReturnVal.hasMore).toStrictEqual(false);

      const countInDb = await validator.getCustomerCount(TEST_ACCOUNT_ID)
      expect(countInDb).toStrictEqual(350);

      const customersInDb = await validator.getCustomerIds(TEST_ACCOUNT_ID);
      expect(customersInDb).toStrictEqual(mockCustomers.map((c) => c.id));
    })

    it('should sync new records for incremental consistency', async () => {
      // New account: run only for customers so it can close when empty.
      const { runKey: initialRun } = await sync.joinOrCreateSyncRun('test', 'customer')
      expect(
        (await sync.processNext('customer', { runStartedAt: initialRun.runStartedAt })).hasMore
      ).toStrictEqual(false)

      const testStartTimestamp = Math.floor(Date.now() / 1000) - 1000;

      mockCustomers = createMockCustomerBatch(100);

      const { runKey: nextRun } = await sync.joinOrCreateSyncRun('test', 'customer')
      const syncReturnVal = await sync.processNext('customer', { runStartedAt: nextRun.runStartedAt });

      expect(syncReturnVal.hasMore).toStrictEqual(false);

      const countInDb = await validator.getCustomerCount(TEST_ACCOUNT_ID)
      expect(countInDb).toStrictEqual(100);

      const customersInDb = await validator.getCustomerIds(TEST_ACCOUNT_ID);

      expect(customersInDb).toStrictEqual(mockCustomers.map((c) => c.id));
      mockCustomers.forEach((c) => {
        expect(c.created).toBeGreaterThan(testStartTimestamp);
      })
    })

    it('should backfill historical records and then pick up new records created during paging', async () => {
      const historicalStartTimestamp = Math.floor(Date.now() / 1000) - 10000;
      const historicalCustomers = createMockCustomerBatch(200, historicalStartTimestamp);
      mockCustomers = historicalCustomers;

      const { runKey: historicalRun } = await sync.joinOrCreateSyncRun('test', 'customer')

      const firstPage = await sync.processNext('customer', { runStartedAt: historicalRun.runStartedAt });
      expect(firstPage.hasMore).toStrictEqual(true);
      expect(firstPage.processed).toStrictEqual(100);

      let countInDb = await validator.getCustomerCount(TEST_ACCOUNT_ID)
      expect(countInDb).toStrictEqual(100);

      // Simulate new records created while the worker is still paging through history.
      const newStartTimestamp = Math.floor(Date.now() / 1000);
      const newCustomers = createMockCustomerBatch(5, newStartTimestamp);
      mockCustomers = [...newCustomers, ...mockCustomers];

      const secondPage = await sync.processNext('customer', { runStartedAt: historicalRun.runStartedAt });
      expect(secondPage.hasMore).toStrictEqual(false);

      countInDb = await validator.getCustomerCount(TEST_ACCOUNT_ID)
      expect(countInDb).toStrictEqual(200);

      const customersAfterBackfill = await validator.getCustomerIds(TEST_ACCOUNT_ID);
      expect(customersAfterBackfill).toStrictEqual(historicalCustomers.map((c) => c.id));

      // Next run should pick up the new records via the incremental cursor.
      const { runKey: incrementalRun } = await sync.joinOrCreateSyncRun('test', 'customer')
      const incrementalResult = await sync.processNext('customer', {
        runStartedAt: incrementalRun.runStartedAt,
      });

      expect(incrementalResult.hasMore).toStrictEqual(false);

      countInDb = await validator.getCustomerCount(TEST_ACCOUNT_ID)
      expect(countInDb).toStrictEqual(205);

      const customersAfterIncremental = await validator.getCustomerIds(TEST_ACCOUNT_ID);
      expect(customersAfterIncremental).toStrictEqual(
        [...historicalCustomers, ...newCustomers].map((c) => c.id)
      );
    })
  })

  describe('processUntilDone', () => {
    it('should sync historical data by paginating through it', async () => {
      mockCustomers = createMockCustomerBatch(350)

      const result = await sync.processUntilDone({ object: 'customer' })

      expect(result.customers?.synced).toStrictEqual(350)

      const countInDb = await validator.getCustomerCount(TEST_ACCOUNT_ID)
      expect(countInDb).toStrictEqual(350)

      const customersInDb = await validator.getCustomerIds(TEST_ACCOUNT_ID);
      expect(customersInDb).toStrictEqual(mockCustomers.map((c) => c.id));
    })

    it('should sync new records for incremental consistency', async () => {
      const initialResult = await sync.processUntilDone({ object: 'customer' })
      expect(initialResult.customers?.synced ?? 0).toStrictEqual(0)

      const testStartTimestamp = Math.floor(Date.now() / 1000) - 1000;

      mockCustomers = createMockCustomerBatch(100);

      const result = await sync.processUntilDone({ object: 'customer' })

      expect(result.customers?.synced).toStrictEqual(100)

      const countInDb = await validator.getCustomerCount(TEST_ACCOUNT_ID)
      expect(countInDb).toStrictEqual(100);

      const customersInDb = await validator.getCustomerIds(TEST_ACCOUNT_ID);
      expect(customersInDb).toStrictEqual(mockCustomers.map((c) => c.id));
      mockCustomers.forEach((c) => {
        expect(c.created).toBeGreaterThan(testStartTimestamp);
      })
    })

    it('should backfill historical records and then pick up new records created during paging', async () => {
      const historicalStartTimestamp = Math.floor(Date.now() / 1000) - 10000;
      const historicalCustomers = createMockCustomerBatch(200, historicalStartTimestamp);
      mockCustomers = historicalCustomers;

      let newCustomers: MockStripeObject[] = []
      let listCallCount = 0

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(sync.stripe as any).customers.list = vi.fn().mockImplementation((params) => {
        listCallCount += 1
        const response = createPaginatedResponse(mockCustomers, params)
        if (listCallCount === 1) {
          const newStartTimestamp = Math.floor(Date.now() / 1000);
          newCustomers = createMockCustomerBatch(5, newStartTimestamp);
          mockCustomers = [...newCustomers, ...mockCustomers];
        }
        return Promise.resolve(response)
      })

      const result = await sync.processUntilDone({ object: 'customer' })
      expect(result.customers?.synced).toStrictEqual(200)

      let countInDb = await validator.getCustomerCount(TEST_ACCOUNT_ID)
      expect(countInDb).toStrictEqual(200);

      const customersAfterBackfill = await validator.getCustomerIds(TEST_ACCOUNT_ID);
      expect(customersAfterBackfill).toStrictEqual(historicalCustomers.map((c) => c.id));

      // Run again to pick up the new records
      await sync.processUntilDone({ object: 'customer' })

      countInDb = await validator.getCustomerCount(TEST_ACCOUNT_ID)
      expect(countInDb).toStrictEqual(205);

      const customersAfterIncremental = await validator.getCustomerIds(TEST_ACCOUNT_ID);
      expect(customersAfterIncremental).toStrictEqual(
        [...historicalCustomers, ...newCustomers].map((c) => c.id)
      );
    })
  })
})
