import Stripe from 'stripe'
import type { ResourceConfig, SyncObject } from './types'
import type { SigmaSyncProcessor } from './sigma/sigmaSyncProcessor'

/**
 * Dependencies injected into buildResourceRegistry so the registry
 * can be constructed without coupling to the StripeSync class.
 */
export type ResourceRegistryDeps = {
  stripe: Stripe
  upsertAny: (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    items: { [Key: string]: any }[],
    accountId: string,
    backfillRelated?: boolean
  ) => Promise<unknown[] | void>
  upsertSubscriptions: (
    items: Stripe.Subscription[],
    accountId: string,
    backfillRelated?: boolean
  ) => Promise<void>
  sigma: SigmaSyncProcessor
}

// Resource registry - maps SyncObject → list/upsert operations for processNext()
// Complements eventHandlers which maps event types → handlers for webhooks
// Both registries share the same underlying upsert methods
// Order field determines backfill sequence - parents before children for FK dependencies
export function buildResourceRegistry(deps: ResourceRegistryDeps): Record<string, ResourceConfig> {
  const { stripe, upsertAny, upsertSubscriptions, sigma } = deps

  const core: Record<string, ResourceConfig> = {
    product: {
      order: 1, // No dependencies
      listFn: (p) => stripe.products.list(p),
      retrieveFn: (id) => stripe.products.retrieve(id),
      upsertFn: (items, id) => upsertAny(items as Stripe.Product[], id),
      supportsCreatedFilter: true,
    },
    price: {
      order: 2, // Depends on product
      listFn: (p) => stripe.prices.list(p),
      retrieveFn: (id) => stripe.prices.retrieve(id),
      upsertFn: (items, id, bf) => upsertAny(items as Stripe.Price[], id, bf),
      supportsCreatedFilter: true,
    },
    plan: {
      order: 3, // Depends on product
      listFn: (p) => stripe.plans.list(p),
      retrieveFn: (id) => stripe.plans.retrieve(id),
      upsertFn: (items, id, bf) => upsertAny(items as Stripe.Plan[], id, bf),
      supportsCreatedFilter: true,
    },
    customer: {
      order: 4, // No dependencies
      listFn: (p) => stripe.customers.list(p),
      retrieveFn: (id) => stripe.customers.retrieve(id),
      upsertFn: (items, id) => upsertAny(items as Stripe.Customer[], id),
      supportsCreatedFilter: true,
    },
    subscription: {
      order: 5, // Depends on customer, price
      listFn: (p) => stripe.subscriptions.list(p),
      retrieveFn: (id) => stripe.subscriptions.retrieve(id),
      upsertFn: (items, id, bf) => upsertSubscriptions(items as Stripe.Subscription[], id, bf),
      listExpands: [
        { items: (id) => stripe.subscriptionItems.list({ subscription: id, limit: 100 }) },
      ],
      supportsCreatedFilter: true,
    },
    subscription_schedules: {
      order: 6, // Depends on customer
      listFn: (p) => stripe.subscriptionSchedules.list(p),
      retrieveFn: (id) => stripe.subscriptionSchedules.retrieve(id),
      upsertFn: (items, id, bf) => upsertAny(items as Stripe.SubscriptionSchedule[], id, bf),
      supportsCreatedFilter: true,
    },
    invoice: {
      order: 7, // Depends on customer, subscription
      listFn: (p) => stripe.invoices.list(p),
      retrieveFn: (id) => stripe.invoices.retrieve(id),
      upsertFn: (items, id, bf) => upsertAny(items as Stripe.Invoice[], id, bf),
      listExpands: [{ lines: (id) => stripe.invoices.listLineItems(id, { limit: 100 }) }],
      supportsCreatedFilter: true,
    },
    charge: {
      order: 8, // Depends on customer, invoice
      listFn: (p) => stripe.charges.list(p),
      retrieveFn: (id) => stripe.charges.retrieve(id),
      upsertFn: (items, id, bf) => upsertAny(items as Stripe.Charge[], id, bf),
      listExpands: [{ refunds: (id) => stripe.refunds.list({ charge: id, limit: 100 }) }],
      supportsCreatedFilter: true,
    },
    setup_intent: {
      order: 9, // Depends on customer
      listFn: (p) => stripe.setupIntents.list(p),
      retrieveFn: (id) => stripe.setupIntents.retrieve(id),
      upsertFn: (items, id, bf) => upsertAny(items as Stripe.SetupIntent[], id, bf),
      supportsCreatedFilter: true,
    },
    payment_method: {
      order: 10, // Depends on customer (special: iterates customers)
      listFn: (p) => stripe.paymentMethods.list(p),
      retrieveFn: (id) => stripe.paymentMethods.retrieve(id),
      upsertFn: (items, id, bf) => upsertAny(items as Stripe.PaymentMethod[], id, bf),
      supportsCreatedFilter: false, // Requires customer param, can't filter by created
    },
    payment_intent: {
      order: 11, // Depends on customer
      listFn: (p) => stripe.paymentIntents.list(p),
      retrieveFn: (id) => stripe.paymentIntents.retrieve(id),
      upsertFn: (items, id, bf) => upsertAny(items as Stripe.PaymentIntent[], id, bf),
      supportsCreatedFilter: true,
    },
    tax_id: {
      order: 12, // Depends on customer
      listFn: (p) => stripe.taxIds.list(p),
      retrieveFn: (id) => stripe.taxIds.retrieve(id),
      upsertFn: (items, id, bf) => upsertAny(items as Stripe.TaxId[], id, bf),
      supportsCreatedFilter: false, // taxIds don't support created filter
    },
    credit_note: {
      order: 13, // Depends on invoice
      listFn: (p) => stripe.creditNotes.list(p),
      retrieveFn: (id) => stripe.creditNotes.retrieve(id),
      upsertFn: (items, id, bf) => upsertAny(items as Stripe.CreditNote[], id, bf),
      listExpands: [
        { listLineItems: (id) => stripe.creditNotes.listLineItems(id, { limit: 100 }) },
      ],
      supportsCreatedFilter: true, // credit_notes support created filter
    },
    dispute: {
      order: 14, // Depends on charge
      listFn: (p) => stripe.disputes.list(p),
      retrieveFn: (id) => stripe.disputes.retrieve(id),
      upsertFn: (items, id, bf) => upsertAny(items as Stripe.Dispute[], id, bf),
      supportsCreatedFilter: true,
    },
    early_fraud_warning: {
      order: 15, // Depends on charge
      listFn: (p) => stripe.radar.earlyFraudWarnings.list(p),
      retrieveFn: (id) => stripe.radar.earlyFraudWarnings.retrieve(id),
      upsertFn: (items, id) => upsertAny(items as Stripe.Radar.EarlyFraudWarning[], id),
      supportsCreatedFilter: true,
    },
    refund: {
      order: 16, // Depends on charge
      listFn: (p) => stripe.refunds.list(p),
      retrieveFn: (id) => stripe.refunds.retrieve(id),
      upsertFn: (items, id, bf) => upsertAny(items as Stripe.Refund[], id, bf),
      supportsCreatedFilter: true,
    },
    checkout_sessions: {
      order: 17, // Depends on customer (optional)
      listFn: (p) => stripe.checkout.sessions.list(p),
      retrieveFn: (id) => stripe.checkout.sessions.retrieve(id),
      upsertFn: (items, id, bf) => upsertAny(items as Stripe.Checkout.Session[], id, bf),
      supportsCreatedFilter: true,
      listExpands: [{ lines: (id) => stripe.checkout.sessions.listLineItems(id, { limit: 100 }) }],
    },
  }

  const maxOrder = Math.max(...Object.values(core).map((cfg) => cfg.order))
  const sigmaEntries = sigma.buildSigmaRegistryEntries(maxOrder)

  // Core configs take precedence over sigma to preserve supportsCreatedFilter and other settings
  return { ...sigmaEntries, ...core }
}

/**
 * Maps Stripe ID prefixes to resource names used in the registry.
 * Used to resolve a Stripe object ID (e.g. "cus_xxx") to its resource type.
 * Prefixes are checked in order; longer prefixes should appear before shorter
 * ones that share a common start (e.g. "issfr_" before "in_").
 */
export const PREFIX_RESOURCE_MAP: Record<string, string> = {
  cus_: 'customer',
  in_: 'invoice',
  price_: 'price',
  prod_: 'product',
  sub_: 'subscription',
  seti_: 'setup_intent',
  pm_: 'payment_method',
  dp_: 'dispute',
  du_: 'dispute',
  ch_: 'charge',
  pi_: 'payment_intent',
  txi_: 'tax_id',
  cn_: 'credit_note',
  issfr_: 'early_fraud_warning',
  prv_: 'review',
  re_: 'refund',
  feat_: 'entitlements_feature',
  cs_: 'checkout_sessions',
}

// Prefixes sorted longest-first so e.g. "issfr_" is tested before "in_"
const SORTED_PREFIXES = Object.keys(PREFIX_RESOURCE_MAP).sort((a, b) => b.length - a.length)

/**
 * Resolve a Stripe object ID (e.g. "cus_abc123") to its resource name
 * in the registry (e.g. "customer"). Returns undefined if the prefix
 * is not recognized.
 */
export function getResourceFromPrefix(stripeId: string): string | undefined {
  const prefix = SORTED_PREFIXES.find((p) => stripeId.startsWith(p))
  return prefix ? PREFIX_RESOURCE_MAP[prefix] : undefined
}

/**
 * Get the resource configuration for a given Stripe ID.
 */
export function getResourceConfigFromId(
  stripeId: string,
  registry: Record<string, ResourceConfig>
): ResourceConfig | undefined {
  const resourceName = getResourceFromPrefix(stripeId)
  return resourceName ? registry[resourceName] : undefined
}

/**
 * Get the database resource name (table name) for a SyncObject type.
 */
const RESOURCE_NAME_MAP: Record<string, string> = {
  customer: 'customers',
  invoice: 'invoices',
  price: 'prices',
  product: 'products',
  subscription: 'subscriptions',
  subscription_schedules: 'subscription_schedules',
  setup_intent: 'setup_intents',
  payment_method: 'payment_methods',
  dispute: 'disputes',
  charge: 'charges',
  payment_intent: 'payment_intents',
  plan: 'plans',
  tax_id: 'tax_ids',
  credit_note: 'credit_notes',
  early_fraud_warning: 'early_fraud_warnings',
  refund: 'refunds',
  checkout_sessions: 'checkout_sessions',
}

export function getResourceName(object: SyncObject | string): string {
  return RESOURCE_NAME_MAP[object] || object
}
