export const CORE_SYNC_OBJECTS = [
  'customer',
  'invoice',
  'price',
  'product',
  'subscription',
  'subscription_schedules',
  'setup_intent',
  'payment_method',
  'dispute',
  'charge',
  'payment_intent',
  'plan',
  'tax_id',
  'credit_note',
  'early_fraud_warning',
  'review',
  'refund',
  'checkout_sessions',
] as const

export type CoreSyncObject = (typeof CORE_SYNC_OBJECTS)[number]

export const SYNC_OBJECTS = ['all', 'customer_with_entitlements', ...CORE_SYNC_OBJECTS] as const
export type SyncObjectName = (typeof SYNC_OBJECTS)[number]

export const REVALIDATE_ENTITIES = [
  'charge',
  'credit_note',
  'customer',
  'dispute',
  'invoice',
  'payment_intent',
  'payment_method',
  'plan',
  'price',
  'product',
  'refund',
  'review',
  'radar.early_fraud_warning',
  'setup_intent',
  'subscription',
  'subscription_schedule',
  'tax_id',
  'entitlements',
] as const

export type RevalidateEntityName = (typeof REVALIDATE_ENTITIES)[number]

type SyncObjectSchemaTableMap = {
  all: []
  customer_with_entitlements: readonly ['customers', 'features', 'active_entitlements']
} & Record<CoreSyncObject, readonly [string, ...string[]]>

const SYNC_OBJECT_SCHEMA_TABLES: SyncObjectSchemaTableMap = {
  all: [],
  customer_with_entitlements: ['customers', 'features', 'active_entitlements'],
  customer: ['customers'],
  invoice: ['invoices'],
  price: ['prices'],
  product: ['products'],
  subscription: ['subscriptions', 'subscription_items'],
  subscription_schedules: ['subscription_schedules'],
  setup_intent: ['setup_intents'],
  payment_method: ['payment_methods'],
  dispute: ['disputes'],
  charge: ['charges'],
  payment_intent: ['payment_intents'],
  plan: ['plans'],
  tax_id: ['tax_ids'],
  credit_note: ['credit_notes'],
  early_fraud_warning: ['early_fraud_warnings'],
  review: ['reviews'],
  refund: ['refunds'],
  checkout_sessions: ['checkout_sessions', 'checkout_session_line_items'],
}

export const SYNC_OBJECT_TO_RESOURCE_TABLE: Record<CoreSyncObject, string> =
  CORE_SYNC_OBJECTS.reduce(
    (resourceMap, objectName) => {
      resourceMap[objectName] = SYNC_OBJECT_SCHEMA_TABLES[objectName][0]
      return resourceMap
    },
    {} as Record<CoreSyncObject, string>
  )

export const RUNTIME_REQUIRED_TABLES: ReadonlyArray<string> = Array.from(
  new Set(SYNC_OBJECTS.flatMap((objectName) => SYNC_OBJECT_SCHEMA_TABLES[objectName]))
)

export function getResourceNameForSyncObject(object: CoreSyncObject): string {
  return SYNC_OBJECT_TO_RESOURCE_TABLE[object]
}

export function isCoreSyncObject(object: string): object is CoreSyncObject {
  return Object.hasOwn(SYNC_OBJECT_TO_RESOURCE_TABLE, object)
}
