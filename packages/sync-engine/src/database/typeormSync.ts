import { DataSource, getMetadataArgsStorage } from 'typeorm'
import type { ConnectionOptions } from 'node:tls'
import type { Logger } from '../types'

// Side-effect imports: each module calls createEntity() which registers
// the entity class in TypeORM's global MetadataArgsStorage.
import '../schemas/account_links'
import '../schemas/account_sessions'
import '../schemas/accounts'
import '../schemas/apple_pay_domains'
import '../schemas/application_fees'
import '../schemas/applications'
import '../schemas/balance'
import '../schemas/balance_transactions'
import '../schemas/bank_accounts'
import '../schemas/capabilities'
import '../schemas/cards'
import '../schemas/cash_balances'
import '../schemas/charges'
import '../schemas/confirmation_tokens'
import '../schemas/connect_collection_transfers'
import '../schemas/country_specs'
import '../schemas/coupons'
import '../schemas/credit_note_line_items'
import '../schemas/credit_notes'
import '../schemas/customer_balance_transactions'
import '../schemas/customer_cash_balance_transactions'
import '../schemas/customer_sessions'
import '../schemas/customers'
import '../schemas/discounts'
import '../schemas/disputes'
import '../schemas/ephemeral_keys'
import '../schemas/events'
import '../schemas/exchange_rates'
import '../schemas/fee_refunds'
import '../schemas/file_links'
import '../schemas/files'
import '../schemas/funding_instructions'
import '../schemas/invoice_items'
import '../schemas/invoice_line_items'
import '../schemas/invoice_rendering_templates'
import '../schemas/invoices'
import '../schemas/line_items'
import '../schemas/login_links'
import '../schemas/mandates'
import '../schemas/o_auth'
import '../schemas/payment_intents'
import '../schemas/payment_links'
import '../schemas/payment_method_configurations'
import '../schemas/payment_method_domains'
import '../schemas/payment_methods'
import '../schemas/payouts'
import '../schemas/persons'
import '../schemas/plans'
import '../schemas/prices'
import '../schemas/product_features'
import '../schemas/products'
import '../schemas/promotion_codes'
import '../schemas/quotes'
import '../schemas/refunds'
import '../schemas/reserve_transactions'
import '../schemas/reviews'
import '../schemas/setup_attempts'
import '../schemas/setup_intents'
import '../schemas/shipping_rates'
import '../schemas/source_mandate_notifications'
import '../schemas/source_transactions'
import '../schemas/sources'
import '../schemas/subscription_items'
import '../schemas/subscription_schedules'
import '../schemas/subscriptions'
import '../schemas/tax_codes'
import '../schemas/tax_deducted_at_sources'
import '../schemas/tax_ids'
import '../schemas/tax_rates'
import '../schemas/tokens'
import '../schemas/topups'
import '../schemas/transfer_reversals'
import '../schemas/transfers'
import '../schemas/usage_record_summaries'
import '../schemas/usage_records'
import '../schemas/webhook_endpoints'

// Tables already managed by the initial SQL migration — exclude from
// TypeORM sync to avoid conflicts with generated columns / special constraints.
const SQL_MANAGED_TABLES = new Set([
  'accounts',
  '_managed_webhooks',
  '_sync_runs',
  '_sync_obj_runs',
  '_rate_limits',
  '_migrations',
])

function collectEntityClasses(): Function[] {
  const storage = getMetadataArgsStorage()
  return storage.tables
    .filter((t) => {
      if (typeof t.target !== 'function') return false
      const name = typeof t.name === 'string' ? t.name : ''
      if (SQL_MANAGED_TABLES.has(name)) return false
      const hasPrimary = storage.columns.some(
        (c) => c.target === t.target && c.options.primary === true
      )
      return hasPrimary
    })
    .map((t) => t.target as Function)
}

export async function syncEntitySchemas(config: {
  databaseUrl: string
  ssl?: ConnectionOptions
  schemaName?: string
  logger?: Logger
}): Promise<void> {
  const entities = collectEntityClasses()
  if (entities.length === 0) {
    config.logger?.info('No TypeORM entities to synchronize')
    return
  }

  const schema = config.schemaName ?? 'stripe'
  config.logger?.info({ entityCount: entities.length, schema }, 'Synchronizing TypeORM entities')

  const dataSource = new DataSource({
    type: 'postgres',
    url: config.databaseUrl,
    schema,
    entities,
    synchronize: false,
    ...(config.ssl ? { ssl: config.ssl as Record<string, unknown> } : {}),
  })

  await dataSource.initialize()
  try {
    await dataSource.synchronize()
    config.logger?.info(
      { entityCount: entities.length },
      'TypeORM entity schema synchronization complete'
    )
  } finally {
    await dataSource.destroy()
  }
}
