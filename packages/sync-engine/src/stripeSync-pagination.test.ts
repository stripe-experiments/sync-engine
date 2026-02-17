import { describe, it, expect, vi, beforeEach } from 'vitest'
import { StripeSyncWorker } from './stripeSyncWorker'
import type { ResourceConfig } from './types'

/**
 * Regression tests for pagination behavior.
 *
 * These tests ensure that objects with supportsCreatedFilter: true
 * correctly pass the `created` filter to Stripe API, preventing
 * infinite loops where the same records are fetched repeatedly.
 *
 * Bug context: credit_notes was incorrectly marked as supportsCreatedFilter: false,
 * causing infinite pagination loops (fetching same 100 records over and over).
 */
describe('Pagination regression tests', () => {
  describe('credit_notes supportsCreatedFilter', () => {
    it('should have supportsCreatedFilter: true for credit_note', async () => {
      // Create a minimal StripeSync instance to check the registry
      const { StripeSync } = await import('./stripeSync')
      const sync = await StripeSync.create({
        stripeSecretKey: 'sk_test_fake',
        databaseUrl: 'postgresql://fake',
      })

      // Access resourceRegistry for testing
      const registry = sync.resourceRegistry

      // credit_note MUST support created filter to enable incremental sync
      // If this is false, pagination will loop infinitely
      expect(registry.credit_note.supportsCreatedFilter).toBe(true)
    })

    it('should have supportsCreatedFilter: true for all core Stripe objects except payment_method and tax_id', async () => {
      const { StripeSync } = await import('./stripeSync')
      const sync = await StripeSync.create({
        stripeSecretKey: 'sk_test_fake',
        databaseUrl: 'postgresql://fake',
      })

      const registry = sync.resourceRegistry

      // Core objects that legitimately don't support created filter
      // (they require customer context and are handled specially)
      const coreObjectsExpectedFalse = ['payment_method', 'tax_id']

      for (const [objectName, config] of Object.entries(registry)) {
        const resourceConfig = config as { supportsCreatedFilter: boolean; sigma?: unknown }

        // Skip sigma-backed tables - they use cursor-based pagination, not created filter
        if (resourceConfig.sigma) {
          continue
        }

        if (coreObjectsExpectedFalse.includes(objectName)) {
          expect(
            resourceConfig.supportsCreatedFilter,
            `${objectName} should have supportsCreatedFilter: false`
          ).toBe(false)
        } else {
          expect(
            resourceConfig.supportsCreatedFilter,
            `${objectName} should have supportsCreatedFilter: true to prevent infinite pagination`
          ).toBe(true)
        }
      }
    })
  })

  describe('StripeSyncWorker.fetchOnePage pagination behavior', () => {
    let mockCreditNotesList: ReturnType<typeof vi.fn>
    let creditNotesConfig: ResourceConfig

    beforeEach(async () => {
      // Create mock functions
      mockCreditNotesList = vi.fn().mockResolvedValue({
        data: [
          { id: 'cn_1', created: 1700000100 },
          { id: 'cn_2', created: 1700000200 },
        ],
        has_more: false,
      })

      creditNotesConfig = {
        tableName: 'credit_notes',
        order: 0,
        supportsCreatedFilter: true,
        listFn: mockCreditNotesList,
        upsertFn: vi.fn().mockResolvedValue([]),
      } as unknown as ResourceConfig
    })

    it('should pass created filter when supportsCreatedFilter is true and cursor exists', async () => {
      // Create a minimal worker to test fetchOnePage
      const worker = new StripeSyncWorker(
        {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        'acct_test',
        {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        { accountId: 'acct_test', runStartedAt: new Date() }
      )

      await worker.fetchOnePage('credit_notes', '1700000000', null, creditNotesConfig)

      expect(mockCreditNotesList).toHaveBeenCalledTimes(1)
      const callArgs = mockCreditNotesList.mock.calls[0][0]

      expect(callArgs).toMatchObject({
        limit: 100,
        created: { gte: 1700000000 },
      })
    })

    it('should NOT have starting_after when pageCursor is null', async () => {
      const worker = new StripeSyncWorker(
        {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        'acct_test',
        {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        { accountId: 'acct_test', runStartedAt: new Date() }
      )

      await worker.fetchOnePage('credit_notes', '1700000000', null, creditNotesConfig)

      const callArgs = mockCreditNotesList.mock.calls[0][0]
      expect(callArgs.starting_after).toBeUndefined()
    })

    it('should include starting_after when pageCursor is provided', async () => {
      const worker = new StripeSyncWorker(
        {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        'acct_test',
        {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        { accountId: 'acct_test', runStartedAt: new Date() }
      )

      await worker.fetchOnePage('credit_notes', '1700000000', 'cn_existing_123', creditNotesConfig)

      const callArgs = mockCreditNotesList.mock.calls[0][0]
      expect(callArgs).toMatchObject({
        limit: 100,
        created: { gte: 1700000000 },
        starting_after: 'cn_existing_123',
      })
    })

    it('should NOT pass created filter when cursor is null (historical backfill)', async () => {
      const worker = new StripeSyncWorker(
        {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        'acct_test',
        {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        { accountId: 'acct_test', runStartedAt: new Date() }
      )

      await worker.fetchOnePage('credit_notes', null, null, creditNotesConfig)

      const callArgs = mockCreditNotesList.mock.calls[0][0]
      expect(callArgs.created).toBeUndefined()
      expect(callArgs.starting_after).toBeUndefined()
    })

    it('should NOT pass created filter when supportsCreatedFilter is false', async () => {
      const noCreatedFilterConfig = {
        ...creditNotesConfig,
        supportsCreatedFilter: false,
      }

      const worker = new StripeSyncWorker(
        {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        'acct_test',
        {} as any, // eslint-disable-line @typescript-eslint/no-explicit-any
        { accountId: 'acct_test', runStartedAt: new Date() }
      )

      await worker.fetchOnePage('credit_notes', '1700000000', null, noCreatedFilterConfig)

      const callArgs = mockCreditNotesList.mock.calls[0][0]
      expect(callArgs.created).toBeUndefined()
    })
  })
})
