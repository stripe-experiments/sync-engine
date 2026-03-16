import { describe, it, expect, vi } from 'vitest'
import type Stripe from 'stripe'
import { createMockedStripeSync } from '../testSetup'

/**
 * Unit tests for webhook special cases where data.object may not be directly persistable.
 */

describe('webhook events without top-level ids', () => {
  it('should include invoice.upcoming in supported event types so the webhook receives it', async () => {
    const stripeSync = await createMockedStripeSync()
    const supportedEvents = stripeSync.webhook.getSupportedEventTypes()
    expect(supportedEvents).toContain('invoice.upcoming')
  })

  it('should include other invoice events in supported event types', async () => {
    const stripeSync = await createMockedStripeSync()
    const supportedEvents = stripeSync.webhook.getSupportedEventTypes()
    expect(supportedEvents).toContain('invoice.created')
    expect(supportedEvents).toContain('invoice.paid')
    expect(supportedEvents).toContain('invoice.finalized')
    expect(supportedEvents).toContain('invoice.updated')
  })

  it('should skip invoice previews whose data.object has no id before account lookup', async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }

    const stripeSync = await createMockedStripeSync({ logger })

    const getAccountIdSpy = vi.fn().mockResolvedValue('acct_test')
    const upsertSpy = vi.fn()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(stripeSync.webhook as any).deps.getAccountId = getAccountIdSpy
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(stripeSync.webhook as any).deps.upsertAny = upsertSpy

    const event = {
      id: 'evt_test_upcoming',
      type: 'invoice.upcoming',
      data: {
        object: {
          object: 'invoice',
          currency: 'usd',
          customer: 'cus_test123',
          subscription: 'sub_test123',
          total: 10000,
          // No 'id' field — this is a preview invoice
        },
      },
      created: Math.floor(Date.now() / 1000),
    } as unknown as Stripe.Event

    await expect(stripeSync.webhook.processEvent(event)).resolves.toBeUndefined()

    expect(getAccountIdSpy).not.toHaveBeenCalled()
    expect(upsertSpy).not.toHaveBeenCalled()

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('Skipping webhook evt_test_upcoming')
    )
  })

  it('should process entitlement summaries even without a top-level id', async () => {
    const stripeSync = await createMockedStripeSync()

    const deleteRemovedActiveEntitlementsSpy = vi.fn().mockResolvedValue(undefined)
    const upsertSpy = vi.fn().mockResolvedValue([])

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(stripeSync.webhook as any).deps.postgresClient.deleteRemovedActiveEntitlements =
      deleteRemovedActiveEntitlementsSpy
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(stripeSync.webhook as any).deps.upsertAny = upsertSpy

    const event = {
      id: 'evt_test_entitlements',
      type: 'entitlements.active_entitlement_summary.updated',
      data: {
        object: {
          object: 'entitlements.active_entitlement_summary',
          customer: 'cus_test123',
          entitlements: {
            data: [
              {
                id: 'ent_test_123',
                object: 'entitlements.active_entitlement',
                feature: 'feat_test_123',
                livemode: false,
                lookup_key: 'journeys',
              },
            ],
          },
          livemode: false,
        },
      },
      created: Math.floor(Date.now() / 1000),
    } as unknown as Stripe.Event

    await expect(stripeSync.webhook.processEvent(event)).resolves.toBeUndefined()

    expect(deleteRemovedActiveEntitlementsSpy).toHaveBeenCalledWith('cus_test123', ['ent_test_123'])
    expect(upsertSpy).toHaveBeenCalledWith(
      [
        {
          id: 'ent_test_123',
          object: 'entitlements.active_entitlement',
          feature: 'feat_test_123',
          customer: 'cus_test123',
          livemode: false,
          lookup_key: 'journeys',
        },
      ],
      'acct_test',
      false,
      expect.any(String)
    )
  })

  it('should process normal invoice events that have an id', async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }

    const stripeSync = await createMockedStripeSync({ logger })

    const upsertSpy = vi.fn().mockResolvedValue([])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(stripeSync.webhook as any).deps.upsertAny = upsertSpy

    const event = {
      id: 'evt_test_paid',
      type: 'invoice.paid',
      data: {
        object: {
          id: 'in_test123',
          object: 'invoice',
          currency: 'usd',
          customer: 'cus_test123',
          status: 'paid',
          total: 10000,
        },
      },
      created: Math.floor(Date.now() / 1000),
    } as unknown as Stripe.Event

    await expect(stripeSync.webhook.processEvent(event)).resolves.toBeUndefined()

    expect(upsertSpy).toHaveBeenCalledWith(
      [event.data.object],
      'acct_test',
      false,
      expect.any(String)
    )
  })
})
