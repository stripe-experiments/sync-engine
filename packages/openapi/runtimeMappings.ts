import type { ParsedColumn } from './types.js'

/**
 * Overrides for x-resourceId values whose table name cannot be inferred by the
 * default snake_case + dot-to-underscore rule in SpecParser.resolveTableName.
 * Values are singular, mirroring Stripe resource names (rule #2 of the schema spec).
 */
export const OPENAPI_RESOURCE_TABLE_ALIASES: Record<string, string> = {
  'radar.early_fraud_warning': 'early_fraud_warning',
  'entitlements.active_entitlement': 'active_entitlement',
  'entitlements.feature': 'feature',
  item: 'checkout_session_line_item',
}

/**
 * Compatibility columns that should exist even if not present in the current OpenAPI shape.
 * This preserves backwards compatibility for existing queries and write paths.
 * todo: Remove this
 */
export const OPENAPI_COMPATIBILITY_COLUMNS: Record<string, ParsedColumn[]> = {
  active_entitlement: [
    { name: 'customer', type: 'text', nullable: true },
    { name: 'object', type: 'text', nullable: true },
    { name: 'feature', type: 'text', nullable: true },
    { name: 'livemode', type: 'boolean', nullable: true },
    { name: 'lookup_key', type: 'text', nullable: true },
  ],
  checkout_session_line_item: [
    { name: 'checkout_session', type: 'text', nullable: true },
    { name: 'amount_discount', type: 'bigint', nullable: true },
    { name: 'amount_tax', type: 'bigint', nullable: true },
  ],
  customer: [{ name: 'deleted', type: 'boolean', nullable: true }],
  early_fraud_warning: [{ name: 'payment_intent', type: 'text', nullable: true }],
  feature: [
    { name: 'object', type: 'text', nullable: true },
    { name: 'name', type: 'text', nullable: true },
    { name: 'lookup_key', type: 'text', nullable: true },
    { name: 'active', type: 'boolean', nullable: true },
    { name: 'livemode', type: 'boolean', nullable: true },
    { name: 'metadata', type: 'json', nullable: true },
  ],
  subscription_item: [
    { name: 'deleted', type: 'boolean', nullable: true },
    { name: 'subscription', type: 'text', nullable: true },
  ],
}
