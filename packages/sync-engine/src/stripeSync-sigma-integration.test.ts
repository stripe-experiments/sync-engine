import { describe, it, beforeAll, afterAll, beforeEach, vi, expect } from 'vitest'
import { StripeSync, runMigrations } from './index'
import pg from 'pg'
import * as sigmaApi from './sigma/sigmaApi'

/**
 * Integration tests for Sigma-backed resources.
 *
 * These tests use a real database connection but mock the Sigma API
 * to test the full ingestion lifecycle without hitting Stripe.
 *
 * Run with:
 * TEST_POSTGRES_DB_URL=postgresql://... vitest run src/stripeSync-sigma-integration.test.ts
 */

const TEST_DB_URL = process.env.TEST_POSTGRES_DB_URL
const TEST_ACCOUNT_ID = 'acct_test_sigma_integration'

const describeWithDb = TEST_DB_URL ? describe : describe.skip

type CsvRow = Record<string, string>

function csvEscape(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function buildCsvContentString(rows: CsvRow[]): string {
  if (rows.length === 0) {
    return ''
  }

  const headers = Object.keys(rows[0])
  const lines = [headers.map(csvEscape).join(',')]
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h] ?? '')).join(','))
  }
  return lines.join('\n')
}

const BASE_EVENT_TIMESTAMP = new Date(Date.UTC(2023, 0, 1, 0, 0, 0))

function formatTimestamp(date: Date): string {
  return date.toISOString().replace('T', ' ').replace('Z', '')
}

function buildSubscriptionItemChangeEventRow(index: number, timestamp: Date): CsvRow {
  const suffix = String(index).padStart(6, '0')
  const ts = formatTimestamp(timestamp)
  return {
    product_id: `prod_sigma_${suffix}`,
    price_id: `price_sigma_${suffix}`,
    customer_id: `cus_sigma_${suffix}`,
    subscription_item_id: `si_sigma_${suffix}`,
    subscription_id: `sub_sigma_${suffix}`,
    currency: 'usd',
    event_timestamp: ts,
    event_type: 'ACTIVE_END',
    mrr_change: String(-100000 + index),
    local_event_timestamp: ts,
    quantity_change: '-1',
  }
}

function buildSubscriptionItemChangeEventRows(
  count: number,
  startIndex: number,
  startTimestamp: Date
): CsvRow[] {
  return Array.from({ length: count }, (_, i) =>
    buildSubscriptionItemChangeEventRow(
      startIndex + i,
      new Date(startTimestamp.getTime() + i * 1000)
    )
  )
}

class SigmaDatabaseValidator {
  private pool: pg.Pool

  constructor(databaseUrl: string) {
    this.pool = new pg.Pool({ connectionString: databaseUrl })
  }

  async getSubscriptionItemChangeEventsCount(accountId: string): Promise<number> {
    const result = await this.pool.query(
      'SELECT COUNT(*) as count FROM stripe.subscription_item_change_events_v2_beta WHERE _account_id = $1',
      [accountId]
    )
    return parseInt(result.rows[0].count, 10)
  }

  async getSubscriptionItemChangeEventIds(accountId: string): Promise<string[]> {
    const result = await this.pool.query(
      'SELECT subscription_item_id FROM stripe.subscription_item_change_events_v2_beta WHERE _account_id = $1 ORDER BY subscription_item_id',
      [accountId]
    )
    return result.rows.map((row) => row.subscription_item_id)
  }

  async clearAccountData(accountId: string): Promise<void> {
    await this.pool.query(
      'DELETE FROM stripe.subscription_item_change_events_v2_beta WHERE _account_id = $1',
      [accountId]
    )
    await this.pool.query('DELETE FROM stripe._sync_obj_runs WHERE _account_id = $1', [accountId])
    await this.pool.query('DELETE FROM stripe._sync_runs WHERE _account_id = $1', [accountId])
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}

describeWithDb('StripeSync Sigma Integration Tests', () => {
  let sync: StripeSync
  let validator: SigmaDatabaseValidator

  beforeAll(async () => {
    if (!TEST_DB_URL) throw new Error('TEST_POSTGRES_DB_URL environment variable is required')
    await runMigrations({ databaseUrl: TEST_DB_URL })
    validator = new SigmaDatabaseValidator(TEST_DB_URL)
  })

  afterAll(async () => {
    if (validator) {
      await validator.close()
    }
    if (sync) {
      await sync.postgresClient.pool.end()
    }
  })

  beforeEach(async () => {
    if (validator) await validator.clearAccountData(TEST_ACCOUNT_ID)

    vi.restoreAllMocks()

    sync = new StripeSync({
      stripeSecretKey: 'sk_test_fake_sigma',
      databaseUrl: TEST_DB_URL!,
      poolConfig: {},
      enableSigma: true,
    })

    await sync.postgresClient.upsertAccount({ id: TEST_ACCOUNT_ID, raw_data: { id: TEST_ACCOUNT_ID } }, 'test_hash')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(sync as any).getCurrentAccount = vi.fn().mockResolvedValue({ id: TEST_ACCOUNT_ID })
  })

  describe('processNext (sigma)', () => {
    it('should sync subscription item change events from Sigma', async () => {
      const baseRows = buildSubscriptionItemChangeEventRows(250, 1, BASE_EVENT_TIMESTAMP)
      const baseCsv = buildCsvContentString(baseRows)

      const sigmaSpy = vi.spyOn(sigmaApi, 'runSigmaQueryAndDownloadCsv').mockResolvedValue({
        queryRunId: 'qr_sub_1',
        fileId: 'file_sub_1',
        csv: baseCsv,
      })

      const { runKey } = await sync.joinOrCreateSyncRun('test', 'subscription_item_change_events_v2_beta')
      const result = await sync.processNext('subscription_item_change_events_v2_beta', {
        runStartedAt: runKey.runStartedAt,
      })

      expect(sigmaSpy).toHaveBeenCalledTimes(1)
      expect(result.processed).toStrictEqual(baseRows.length)
      expect(result.hasMore).toStrictEqual(false)

      const count = await validator.getSubscriptionItemChangeEventsCount(TEST_ACCOUNT_ID)
      expect(count).toStrictEqual(baseRows.length)

      const ids = await validator.getSubscriptionItemChangeEventIds(TEST_ACCOUNT_ID)
      expect(ids).toStrictEqual(baseRows.map((row) => row.subscription_item_id))
    })

    it('should backfill across pages then pick up new rows on a later run', async () => {
      const baseRows = buildSubscriptionItemChangeEventRows(180, 1, BASE_EVENT_TIMESTAMP)

      const basePage1 = baseRows.slice(0, 100); //1-100
      const basePage2 = baseRows.slice(100); //101-180

      const pages = [basePage1, basePage2]
      const cursorRows: Array<CsvRow | null> = [null, basePage1[99]!, baseRows[179]!]

      const expectSqlCursor = (sql: string, cursor: CsvRow | null) => {
        if (!cursor) {
          expect(sql).not.toContain('WHERE')
          return
        }

        expect(sql).toContain(`timestamp '${cursor.event_timestamp}'`)
        expect(sql).toContain(`event_type = '${cursor.event_type}'`)
        expect(sql).toContain(`subscription_item_id > '${cursor.subscription_item_id}'`)
      }

      // Force a small page size so to exercise multi-page cursor paging.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sigmaConfig = (sync as any).resourceRegistry?.subscription_item_change_events_v2_beta?.sigma
      if (!sigmaConfig) {
        throw new Error('Missing sigma config for subscription_item_change_events_v2_beta')
      }
      const originalPageSize = sigmaConfig.pageSize
      sigmaConfig.pageSize = 100

      let callCount = 0
      vi.spyOn(sigmaApi, 'runSigmaQueryAndDownloadCsv').mockImplementation(async ({ sql }) => {
        if (!sql.includes('subscription_item_change_events_v2_beta')) {
          throw new Error(`Unexpected Sigma query: ${sql}`)
        }
        if (callCount >= pages.length) {
          throw new Error(`Unexpected Sigma call #${callCount + 1}`)
        }

        expectSqlCursor(sql, cursorRows[callCount] ?? null)
        const pageRows = pages[callCount] ?? []

        callCount += 1
        return {
          queryRunId: `qr_sub_${callCount}`,
          fileId: `file_sub_${callCount}`,
          csv: buildCsvContentString(pageRows),
        }
      })

      try {
        const { runKey: runA } = await sync.joinOrCreateSyncRun(
          'test',
          'subscription_item_change_events_v2_beta'
        )
        const first = await sync.processNext('subscription_item_change_events_v2_beta', {
          runStartedAt: runA.runStartedAt,
        })

        expect(first.hasMore).toStrictEqual(true)
        const countAfterFirstPage =
          await validator.getSubscriptionItemChangeEventsCount(TEST_ACCOUNT_ID)
        expect(countAfterFirstPage).toStrictEqual(100)

        const second = await sync.processNext('subscription_item_change_events_v2_beta', {
          runStartedAt: runA.runStartedAt,
        })

        expect(second.hasMore).toStrictEqual(false)
        expect(callCount).toStrictEqual(2)

        const countAfterBackfill = await validator.getSubscriptionItemChangeEventsCount(TEST_ACCOUNT_ID)
        expect(countAfterBackfill).toStrictEqual(180)

        // New rows appear after the backfill run completes.
        const newRows = buildSubscriptionItemChangeEventRows(
          180,
          181,
          new Date(Date.now() + 10000)
        )
        const newPage1 = newRows.slice(0, 100); //181-280
        const newPage2 = newRows.slice(100); //281-360
        pages.push(newPage1, newPage2)
        cursorRows.push(newPage1[99]!)

        const { runKey: runB } = await sync.joinOrCreateSyncRun(
          'test',
          'subscription_item_change_events_v2_beta'
        )
        const third = await sync.processNext('subscription_item_change_events_v2_beta', {
          runStartedAt: runB.runStartedAt,
        })

        expect(third.hasMore).toStrictEqual(true)
        const countAfterFirstIncrementalPage =
          await validator.getSubscriptionItemChangeEventsCount(TEST_ACCOUNT_ID)
        expect(countAfterFirstIncrementalPage).toStrictEqual(280)

        const fourth = await sync.processNext('subscription_item_change_events_v2_beta', {
          runStartedAt: runB.runStartedAt,
        })

        expect(fourth.hasMore).toStrictEqual(false)

        const count = await validator.getSubscriptionItemChangeEventsCount(TEST_ACCOUNT_ID)
        expect(count).toStrictEqual(360)
      } finally {
        sigmaConfig.pageSize = originalPageSize
      }
    })

  })

  describe('processUntilDone (sigma)', () => {
    it('should sync subscription item change events from Sigma', async () => {
      const baseRows = buildSubscriptionItemChangeEventRows(250, 1, BASE_EVENT_TIMESTAMP)
      const baseCsv = buildCsvContentString(baseRows)

      vi.spyOn(sigmaApi, 'runSigmaQueryAndDownloadCsv').mockResolvedValue({
        queryRunId: 'qr_sub_3',
        fileId: 'file_sub_3',
        csv: baseCsv,
      })

      const result = await sync.processUntilDone({ object: 'subscription_item_change_events_v2_beta' })

      expect(result.subscriptionItemChangeEventsV2Beta?.synced).toStrictEqual(baseRows.length)

      const count = await validator.getSubscriptionItemChangeEventsCount(TEST_ACCOUNT_ID)
      expect(count).toStrictEqual(baseRows.length)
    })

    it('should paginate sigma results using cursor across multiple pages', async () => {
      const baseRows = buildSubscriptionItemChangeEventRows(250, 1, BASE_EVENT_TIMESTAMP)

      // Force a small page size so we exercise multi-page cursor paging.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sigmaConfig = (sync as any).resourceRegistry?.subscription_item_change_events_v2_beta?.sigma
      if (!sigmaConfig) {
        throw new Error('Missing sigma config for subscription_item_change_events_v2_beta')
      }

      const originalPageSize = sigmaConfig.pageSize
      sigmaConfig.pageSize = 100

      const sqlCalls: string[] = []
      const sigmaSpy = vi.spyOn(sigmaApi, 'runSigmaQueryAndDownloadCsv').mockImplementation(
        async ({ sql }) => {
          sqlCalls.push(sql)
          const start = (sqlCalls.length - 1) * sigmaConfig.pageSize
          const pageRows = baseRows.slice(start, start + sigmaConfig.pageSize)
          return {
            queryRunId: `qr_page_${sqlCalls.length}`,
            fileId: `file_page_${sqlCalls.length}`,
            csv: buildCsvContentString(pageRows),
          }
        }
      )

      try {
        const result = await sync.processUntilDone({
          object: 'subscription_item_change_events_v2_beta',
        })

        expect(sigmaSpy).toHaveBeenCalled()
        expect(result.subscriptionItemChangeEventsV2Beta?.synced).toStrictEqual(
          baseRows.length
        )
      } finally {
        sigmaConfig.pageSize = originalPageSize
      }
    })

    it('should pick up new subscription item change events on subsequent runs', async () => {
      const baseRows = buildSubscriptionItemChangeEventRows(250, 1, BASE_EVENT_TIMESTAMP)
      const baseCsv = buildCsvContentString(baseRows)
      const newRows = buildSubscriptionItemChangeEventRows(
        5,
        baseRows.length + 1,
        new Date(BASE_EVENT_TIMESTAMP.getTime() + (baseRows.length + 10) * 1000)
      )
      const csvs = [baseCsv, buildCsvContentString(newRows)]
      vi.spyOn(sigmaApi, 'runSigmaQueryAndDownloadCsv').mockImplementation(async ({ sql }) => {
        if (!sql.includes('subscription_item_change_events_v2_beta')) {
          throw new Error(`Unexpected Sigma query: ${sql}`)
        }
        const csv = csvs.shift() ?? baseCsv
        return { queryRunId: 'qr_sub_4', fileId: 'file_sub_4', csv }
      })

      const first = await sync.processUntilDone({ object: 'subscription_item_change_events_v2_beta' })
      expect(first.subscriptionItemChangeEventsV2Beta?.synced).toStrictEqual(baseRows.length)

      const second = await sync.processUntilDone({ object: 'subscription_item_change_events_v2_beta' })
      expect(second.subscriptionItemChangeEventsV2Beta?.synced).toStrictEqual(newRows.length)

      const count = await validator.getSubscriptionItemChangeEventsCount(TEST_ACCOUNT_ID)
      expect(count).toStrictEqual(baseRows.length + newRows.length)
    })
  })
})

