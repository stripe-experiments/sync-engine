import type { ParsedColumn } from './types'

/**
 * Table names that must exist for runtime sync and webhook processing.
 * Includes all default sync objects plus child tables.
 */
export const RUNTIME_REQUIRED_TABLES: ReadonlyArray<string> = [
  'products',
  'coupons',
  'prices',
  'plans',
  'customers',
  'subscriptions',
  'subscription_schedules',
  'invoices',
  'charges',
  'setup_intents',
  'payment_methods',
  'payment_intents',
  'tax_ids',
  'credit_notes',
  'disputes',
  'early_fraud_warnings',
  'refunds',
  'checkout_sessions',
  'subscription_items',
  'checkout_session_line_items',
  'features',
]

/**
 * Overrides for x-resourceId values whose table name cannot be inferred by the
 * default pluralisation / dot-to-underscore rule in SpecParser.resolveTableName.
 */
export const OPENAPI_RESOURCE_TABLE_ALIASES: Record<string, string> = {
  'radar.early_fraud_warning': 'early_fraud_warnings',
  'entitlements.active_entitlement': 'active_entitlements',
  'entitlements.feature': 'features',
  item: 'checkout_session_line_items',
}

/**
 * Compatibility columns that should exist even if not present in the current OpenAPI shape.
 * This preserves backwards compatibility for existing queries and write paths.
 * todo: Remove this
 */
export const OPENAPI_COMPATIBILITY_COLUMNS: Record<string, ParsedColumn[]> = {
  active_entitlements: [
    { name: 'customer', type: 'text', nullable: true },
    { name: 'object', type: 'text', nullable: true },
    { name: 'feature', type: 'text', nullable: true },
    { name: 'livemode', type: 'boolean', nullable: true },
    { name: 'lookup_key', type: 'text', nullable: true },
  ],
  checkout_session_line_items: [
    { name: 'checkout_session', type: 'text', nullable: true },
    { name: 'amount_discount', type: 'bigint', nullable: true },
    { name: 'amount_tax', type: 'bigint', nullable: true },
  ],
  customers: [{ name: 'deleted', type: 'boolean', nullable: true }],
  early_fraud_warnings: [{ name: 'payment_intent', type: 'text', nullable: true }],
  features: [
    { name: 'object', type: 'text', nullable: true },
    { name: 'name', type: 'text', nullable: true },
    { name: 'lookup_key', type: 'text', nullable: true },
    { name: 'active', type: 'boolean', nullable: true },
    { name: 'livemode', type: 'boolean', nullable: true },
    { name: 'metadata', type: 'json', nullable: true },
  ],
  subscription_items: [
    { name: 'deleted', type: 'boolean', nullable: true },
    { name: 'subscription', type: 'text', nullable: true },
  ],
}
