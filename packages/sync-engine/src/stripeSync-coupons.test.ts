import { describe, it, expect, vi, beforeEach } from 'vitest'
import Stripe from 'stripe'
import { StripeSync } from './stripeSync'

const baseConfig = {
  stripeSecretKey: 'sk_test_fake',
  databaseUrl: 'postgresql://fake',
  poolConfig: {},
}

describe('Coupons sync and backfill', () => {
  let sync: StripeSync

  beforeEach(() => {
    sync = new StripeSync(baseConfig)
  })

  it('backfills coupons referenced by subscriptions when backfillRelatedEntities is enabled', async () => {
    // Stubs to avoid DB/Stripe calls
    sync.expandEntity = vi.fn().mockResolvedValue(undefined)
    sync.postgresClient.upsertManyWithTimestampProtection = vi.fn().mockResolvedValue([])
    sync.upsertSubscriptionItems = vi.fn().mockResolvedValue([])
    sync.markDeletedSubscriptionItems = vi.fn().mockResolvedValue({ rowCount: 0 })
    sync.backfillCustomers = vi.fn().mockResolvedValue(undefined)
    const backfillCoupons = vi.fn().mockResolvedValue(undefined)
    sync.backfillCoupons = backfillCoupons

    const subscriptions: Stripe.Subscription[] = [
      {
        id: 'sub_1',
        object: 'subscription',
        customer: 'cus_1',
        items: { data: [], object: 'list', has_more: false, url: '/v1/subscription_items' },
        latest_invoice: null,
        status: 'active',
        discount: { coupon: { id: 'co_123', object: 'coupon', created: 0, valid: true } } as any,
        created: 0,
      } as Stripe.Subscription,
    ]

    await sync.upsertSubscriptions(subscriptions, 'acct_1', true)

    expect(backfillCoupons).toHaveBeenCalledTimes(1)
    expect(backfillCoupons).toHaveBeenCalledWith(['co_123'], 'acct_1')
  })

  it('backfills coupons referenced by invoices when backfillRelatedEntities is enabled', async () => {
    sync.expandEntity = vi.fn().mockResolvedValue(undefined)
    sync.postgresClient.upsertManyWithTimestampProtection = vi.fn().mockResolvedValue([])
    sync.backfillCustomers = vi.fn().mockResolvedValue(undefined)
    sync.backfillSubscriptions = vi.fn().mockResolvedValue(undefined)
    const backfillCoupons = vi.fn().mockResolvedValue(undefined)
    sync.backfillCoupons = backfillCoupons

    const invoices: Stripe.Invoice[] = [
      {
        id: 'in_1',
        object: 'invoice',
        customer: 'cus_1',
        subscription: 'sub_1',
        discount: { coupon: { id: 'co_primary', object: 'coupon', created: 0, valid: true } } as any,
        discounts: [
          {
            object: 'discount',
            id: 'di_1',
            coupon: { id: 'co_extra', object: 'coupon', created: 0, valid: true } as any,
          } as any,
        ],
        created: 0,
        lines: { data: [], object: 'list', has_more: false, url: '/v1/invoices/in_1/lines' },
      } as Stripe.Invoice,
    ]

    await sync.upsertInvoices(invoices, 'acct_1', true)

    expect(backfillCoupons).toHaveBeenCalledTimes(1)
    expect(backfillCoupons).toHaveBeenCalledWith(expect.arrayContaining(['co_primary', 'co_extra']), 'acct_1')
  })

  it('processEvent routes coupon.created and coupon.deleted to the correct handlers', async () => {
    const upsertCoupons = vi.fn().mockResolvedValue([])
    const deleteCoupon = vi.fn().mockResolvedValue(true)
    sync.upsertCoupons = upsertCoupons
    sync.deleteCoupon = deleteCoupon

    // Stub account lookups
    ;(sync as any).getAccountId = vi.fn().mockResolvedValue('acct_test')
    ;(sync as any).getCurrentAccount = vi.fn().mockResolvedValue({ id: 'acct_test' })

    const coupon = {
      id: 'co_webhook',
      object: 'coupon',
      created: 1,
      valid: true,
    } as Stripe.Coupon

    const createdEvent: Stripe.Event = {
      id: 'evt_created',
      object: 'event',
      api_version: '2023-10-16',
      created: 1,
      data: { object: coupon },
      livemode: false,
      pending_webhooks: 0,
      request: { id: null, idempotency_key: null },
      type: 'coupon.created',
    }

    await sync.processEvent(createdEvent)
    expect(upsertCoupons).toHaveBeenCalledTimes(1)
    expect(upsertCoupons).toHaveBeenCalledWith([coupon], 'acct_test', expect.any(String))

    const deletedEvent: Stripe.Event = {
      id: 'evt_deleted',
      object: 'event',
      api_version: '2023-10-16',
      created: 2,
      data: { object: { id: 'co_webhook', object: 'coupon', deleted: true } as any },
      livemode: false,
      pending_webhooks: 0,
      request: { id: null, idempotency_key: null },
      type: 'coupon.deleted',
    }

    await sync.processEvent(deletedEvent)
    expect(deleteCoupon).toHaveBeenCalledTimes(1)
    expect(deleteCoupon).toHaveBeenCalledWith('co_webhook')
  })
})
