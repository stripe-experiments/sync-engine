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

const SUBSCRIPTION_ITEM_CHANGE_EVENTS_ROWS: CsvRow[] = [
  {
    product_id: 'prod_NFU1H7G9O6dqj3',
    price_id: 'price_0MUzBR589O8KAxCGQep2LyvD',
    customer_id: 'cus_NFU2X7zEsEAcOJ',
    subscription_item_id: 'si_NFUADXdQKDnNxn',
    subscription_id: 'sub_0MUz9F589O8KAxCGzt8M4u5H',
    currency: 'usd',
    event_timestamp: '2023-01-27 21:11:42.000',
    event_type: 'ACTIVE_END',
    mrr_change: '-100000',
    local_event_timestamp: '2023-01-27 13:11:42.000',
    quantity_change: '-1',
  },
  {
    product_id: 'prod_DYaHhTYQLogj75',
    price_id: 'plan_DYaKhCY4CQ14Cy',
    customer_id: 'cus_DpsfXVbW3HZLSv',
    subscription_item_id: 'si_DpsjeUemmW9ljj',
    subscription_id: 'sub_DpsjGsJiLuSGPp',
    currency: 'usd',
    event_timestamp: '2018-10-26 05:23:12.000',
    event_type: 'ACTIVE_END',
    mrr_change: '0',
    local_event_timestamp: '2018-10-25 22:23:12.000',
    quantity_change: '-7',
  },
  {
    product_id: 'prod_P8OssNW5P3wiLE',
    price_id: 'price_0OK84l589O8KAxCGalR5zK0k',
    customer_id: 'cus_P8OmaVkwf2Fd5A',
    subscription_item_id: 'si_P8Os4M6yCujDPy',
    subscription_id: 'sub_0OK84o589O8KAxCGCTzYTlhb',
    currency: 'usd',
    event_timestamp: '2023-12-06 00:29:54.000',
    event_type: 'ACTIVE_END',
    mrr_change: '0',
    local_event_timestamp: '2023-12-05 16:29:54.000',
    quantity_change: '-1',
  },
]

const SUBSCRIPTION_ITEM_CHANGE_EVENTS_NEW_ROWS: CsvRow[] = [
  {
    product_id: 'prod_NEW',
    price_id: 'price_NEW',
    customer_id: 'cus_NEW',
    subscription_item_id: 'si_NEW',
    subscription_id: 'sub_NEW',
    currency: 'usd',
    event_timestamp: '2024-01-01 00:00:00.000',
    event_type: 'ACTIVE_END',
    mrr_change: '0',
    local_event_timestamp: '2024-01-01 00:00:00.000',
    quantity_change: '1',
  },
]

const EXCHANGE_RATES_ROWS: CsvRow[] = [
  {
    date: '2021-03-07 00:00:00.000',
    sell_currency: 'usd',
    buy_currency_exchange_rates:
      '{"rub":74.3451,"sdg":380.0,"fkp":0.722788,"cuc":1.0,"idr":14399.15,"sll":10201.75017,"xpd":4.2656E-4,"bhd":3.7711499999999996,"pyg":66.64480705,"ssp":130.26,"gnf":100.8,"zmw":21.919498,"cad":1.26541,"nok":8.5574,"sar":3.752242,"jod":7.09,"xaf":5.50479606,"cve":92.625,"try":7.5388,"inr":73.1809,"xau":5.8787E-4,"bgn":1.641285,"myr":4.074,"mzn":74.6,"gel":3.325,"lbp":1524.40851,"tzs":2319.0,"szl":15.115703,"gtq":7.70379,"omr":3.85034,"bbd":2.0,"mru":35.98,"all":103.422016,"cnh":6.5083,"clp":7.33399104,"ugx":3656.29397,"gbp":0.722788,"xpt":8.8379E-4,"qar":3.641,"amd":523.335134,"xof":5.50479606,"ngn":381.0,"gip":0.722788,"srd":14.154,"uzs":10490.0,"gyd":209.115862,"sgd":1.3424,"ern":14.999786,"hkd":7.763355,"pln":3.851825,"nio":35.045,"lsl":15.287456,"dop":57.9,"nzd":1.394992,"std":20337.466992,"vnd":230.65017127,"mro":356.999828,"cup":25.75,"mur":39.853644,"pen":3.691,"tjs":11.389571,"iqd":14625.0,"pkr":157.0,"bsd":1.0,"uah":27.749278,"tmt":3.51,"mwk":780.937682,"scr":21.21469,"rwf":9.93023625,"tnd":27.43,"lrd":173.924986,"zwl":322.0,"uyu":43.923162,"bdt":84.755236,"jmd":151.091863,"vuv":1.07677018,"npr":116.427339,"egp":15.69725,"awg":1.8,"mxn":21.31519,"syp":512.870573,"azn":1.700805,"lkr":195.908041,"thb":30.556138,"clf":0.026579,"ggp":0.722788,"gmd":51.4,"kzt":419.786328,"isk":128.33,"ils":3.33261,"czk":22.0916,"lak":9365.0,"htg":77.517875,"mdl":17.550109,"khr":4060.0,"pgk":3.5325,"fjd":2.035,"bob":6.891786,"wst":2.528329,"php":48.617419,"shp":0.722788,"mga":37.44,"byn":2.60867,"djf":1.780375,"kmf":4.13350013,"kyd":0.832928,"aed":3.673,"afn":77.449998,"bzd":2.014744,"ttd":6.784727,"twd":27.9425,"cop":3649.717748,"mop":7.992612,"xpf":1.00143288,"crc":612.137816,"cny":6.4968,"lyd":4.472126,"stn":20.67,"dzd":133.142566,"ves":1872414.0,"xcd":2.70255,"svc":8.746387,"btc":2.0441459E-5,"mnt":2852.765119,"kgs":84.634401,"sos":585.0,"imp":0.722788,"aud":1.300972,"yer":250.350066,"mvr":15.4,"ron":4.0983,"cdf":1994.0,"jpy":1.0835498382,"jep":0.722788,"nad":15.36,"ang":1.794193,"bnd":1.331312,"mmk":1409.342666,"irr":42105.0,"brl":5.6911,"ars":90.297917,"xag":0.03961497,"sbd":7.985424,"bwp":11.086561,"hnl":24.35,"kwd":3.03095,"usd":1.0,"dkk":6.242,"sek":8.531268,"mkd":51.662999,"kpw":900.0,"xdr":0.698037,"top":2.283438,"btn":72.767103,"chf":0.930716,"aoa":624.234,"bam":1.635091,"huf":308.3225,"bif":19.6,"rsd":98.239368,"pab":1.0,"hrk":6.3557,"eur":0.839201,"zar":15.36436,"ghs":5.74,"kes":109.6,"mad":9.0205,"krw":11.28225,"bmd":1.0,"etb":40.25}',
  },
]

const SUBSCRIPTION_ITEM_CHANGE_EVENTS_CSV = buildCsvContentString(SUBSCRIPTION_ITEM_CHANGE_EVENTS_ROWS)
const SUBSCRIPTION_ITEM_CHANGE_EVENTS_NEW_CSV = buildCsvContentString(
  SUBSCRIPTION_ITEM_CHANGE_EVENTS_NEW_ROWS
)
const EXCHANGE_RATES_CSV = buildCsvContentString(EXCHANGE_RATES_ROWS)

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

  async getExchangeRatesCount(accountId: string): Promise<number> {
    const result = await this.pool.query(
      'SELECT COUNT(*) as count FROM stripe.exchange_rates_from_usd WHERE _account_id = $1',
      [accountId]
    )
    return parseInt(result.rows[0].count, 10)
  }

  async getExchangeRateKeys(accountId: string): Promise<Array<{ date: string; sell_currency: string }>> {
    const result = await this.pool.query(
      'SELECT date, sell_currency FROM stripe.exchange_rates_from_usd WHERE _account_id = $1 ORDER BY date',
      [accountId]
    )
    return result.rows.map((row) => ({
      date: row.date instanceof Date ? row.date.toISOString().slice(0, 10) : String(row.date),
      sell_currency: row.sell_currency,
    }))
  }

  async clearAccountData(accountId: string): Promise<void> {
    await this.pool.query(
      'DELETE FROM stripe.subscription_item_change_events_v2_beta WHERE _account_id = $1',
      [accountId]
    )
    await this.pool.query('DELETE FROM stripe.exchange_rates_from_usd WHERE _account_id = $1', [
      accountId,
    ])
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
      const sigmaSpy = vi.spyOn(sigmaApi, 'runSigmaQueryAndDownloadCsv').mockResolvedValue({
        queryRunId: 'qr_sub_1',
        fileId: 'file_sub_1',
        csv: SUBSCRIPTION_ITEM_CHANGE_EVENTS_CSV,
      })

      const { runKey } = await sync.joinOrCreateSyncRun('test', 'subscription_item_change_events_v2_beta')
      const result = await sync.processNext('subscription_item_change_events_v2_beta', {
        runStartedAt: runKey.runStartedAt,
      })

      expect(sigmaSpy).toHaveBeenCalledTimes(1)
      expect(result.processed).toStrictEqual(3)
      expect(result.hasMore).toStrictEqual(false)

      const count = await validator.getSubscriptionItemChangeEventsCount(TEST_ACCOUNT_ID)
      expect(count).toStrictEqual(3)

      const ids = await validator.getSubscriptionItemChangeEventIds(TEST_ACCOUNT_ID)
      expect(ids).toStrictEqual(['si_DpsjeUemmW9ljj', 'si_NFUADXdQKDnNxn', 'si_P8Os4M6yCujDPy'])
    })

    it('should pick up new subscription item change events on subsequent runs', async () => {
      const csvs = [SUBSCRIPTION_ITEM_CHANGE_EVENTS_CSV, SUBSCRIPTION_ITEM_CHANGE_EVENTS_NEW_CSV]
      vi.spyOn(sigmaApi, 'runSigmaQueryAndDownloadCsv').mockImplementation(async ({ sql }) => {
        if (!sql.includes('subscription_item_change_events_v2_beta')) {
          throw new Error(`Unexpected Sigma query: ${sql}`)
        }
        const csv = csvs.shift() ?? SUBSCRIPTION_ITEM_CHANGE_EVENTS_CSV
        return { queryRunId: 'qr_sub_2', fileId: 'file_sub_2', csv }
      })

      const { runKey: runA } = await sync.joinOrCreateSyncRun(
        'test',
        'subscription_item_change_events_v2_beta'
      )
      await sync.processNext('subscription_item_change_events_v2_beta', {
        runStartedAt: runA.runStartedAt,
      })

      const { runKey: runB } = await sync.joinOrCreateSyncRun(
        'test',
        'subscription_item_change_events_v2_beta'
      )
      const result = await sync.processNext('subscription_item_change_events_v2_beta', {
        runStartedAt: runB.runStartedAt,
      })

      expect(result.processed).toStrictEqual(1)
      expect(result.hasMore).toStrictEqual(false)

      const count = await validator.getSubscriptionItemChangeEventsCount(TEST_ACCOUNT_ID)
      expect(count).toStrictEqual(4)
    })

    it('should sync exchange rates from Sigma', async () => {
      vi.spyOn(sigmaApi, 'runSigmaQueryAndDownloadCsv').mockImplementation(async ({ sql }) => {
        if (!sql.includes('exchange_rates_from_usd')) {
          throw new Error(`Unexpected Sigma query: ${sql}`)
        }
        return { queryRunId: 'qr_fx_1', fileId: 'file_fx_1', csv: EXCHANGE_RATES_CSV }
      })

      const { runKey } = await sync.joinOrCreateSyncRun('test', 'exchange_rates_from_usd')
      const result = await sync.processNext('exchange_rates_from_usd', {
        runStartedAt: runKey.runStartedAt,
      })

      expect(result.processed).toStrictEqual(1)
      expect(result.hasMore).toStrictEqual(false)

      const count = await validator.getExchangeRatesCount(TEST_ACCOUNT_ID)
      expect(count).toStrictEqual(1)

      const keys = await validator.getExchangeRateKeys(TEST_ACCOUNT_ID)
      expect(keys).toStrictEqual([{ date: '2021-03-07', sell_currency: 'usd' }])
    })
  })

  describe('processUntilDone (sigma)', () => {
    it('should sync subscription item change events from Sigma', async () => {
      vi.spyOn(sigmaApi, 'runSigmaQueryAndDownloadCsv').mockResolvedValue({
        queryRunId: 'qr_sub_3',
        fileId: 'file_sub_3',
        csv: SUBSCRIPTION_ITEM_CHANGE_EVENTS_CSV,
      })

      const result = await sync.processUntilDone({ object: 'subscription_item_change_events_v2_beta' })

      expect(result.subscriptionItemChangeEventsV2Beta?.synced).toStrictEqual(3)

      const count = await validator.getSubscriptionItemChangeEventsCount(TEST_ACCOUNT_ID)
      expect(count).toStrictEqual(3)
    })

    it('should pick up new subscription item change events on subsequent runs', async () => {
      const csvs = [SUBSCRIPTION_ITEM_CHANGE_EVENTS_CSV, SUBSCRIPTION_ITEM_CHANGE_EVENTS_NEW_CSV]
      vi.spyOn(sigmaApi, 'runSigmaQueryAndDownloadCsv').mockImplementation(async ({ sql }) => {
        if (!sql.includes('subscription_item_change_events_v2_beta')) {
          throw new Error(`Unexpected Sigma query: ${sql}`)
        }
        const csv = csvs.shift() ?? SUBSCRIPTION_ITEM_CHANGE_EVENTS_CSV
        return { queryRunId: 'qr_sub_4', fileId: 'file_sub_4', csv }
      })

      const first = await sync.processUntilDone({ object: 'subscription_item_change_events_v2_beta' })
      expect(first.subscriptionItemChangeEventsV2Beta?.synced).toStrictEqual(3)

      const second = await sync.processUntilDone({ object: 'subscription_item_change_events_v2_beta' })
      expect(second.subscriptionItemChangeEventsV2Beta?.synced).toStrictEqual(1)

      const count = await validator.getSubscriptionItemChangeEventsCount(TEST_ACCOUNT_ID)
      expect(count).toStrictEqual(4)
    })
  })
})

