import { randomUUID } from 'node:crypto'
import type { EndpointDefinition } from '../openapi/endpoints.js'

const ID_PREFIXES: Record<string, string> = {
  accounts: 'acct',
  apple_pay_domains: 'apftw',
  application_fees: 'fee',
  balance_transactions: 'txn',
  billing_alerts: 'alrt',
  billing_credit_balance_transactions: 'cbtxn',
  billing_credit_grants: 'credgr',
  billing_meters: 'mtr',
  billing_portal_configurations: 'bpc',
  charges: 'ch',
  checkout_sessions: 'cs',
  climate_orders: 'climorder',
  climate_products: 'climsku',
  climate_suppliers: 'climsup',
  country_specs: 'cspec',
  coupons: 'cpn',
  credit_notes: 'cn',
  customers: 'cus',
  disputes: 'dp',
  events: 'evt',
  exchange_rates: 'xr',
  file_links: 'link',
  files: 'file',
  invoiceitems: 'ii',
  invoices: 'in',
  payment_intents: 'pi',
  payment_links: 'plink',
  payment_methods: 'pm',
  payouts: 'po',
  plans: 'plan',
  prices: 'price',
  products: 'prod',
  promotion_codes: 'promo',
  quotes: 'qt',
  refunds: 're',
  setup_intents: 'seti',
  subscriptions: 'sub',
  subscription_schedules: 'sub_sched',
  tax_ids: 'txi',
  tax_rates: 'txr',
  topups: 'tu',
  transfers: 'tr',
  webhook_endpoints: 'we',
  v2_core_accounts: 'acct',
  v2_core_event_destinations: 'ed',
  v2_core_events: 'evt',
}

export function generateStubObjects(
  endpoint: EndpointDefinition,
  count: number
): Record<string, unknown>[] {
  const prefix = ID_PREFIXES[endpoint.tableName] ?? endpoint.tableName.replace(/^v2_/, '').slice(0, 6)
  const objects: Record<string, unknown>[] = []

  for (let i = 0; i < count; i++) {
    const id = `${prefix}_seed${randomUUID().replace(/-/g, '').slice(0, 20)}`
    objects.push({
      id,
      object: endpoint.resourceId,
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      metadata: {},
    })
  }

  return objects
}
