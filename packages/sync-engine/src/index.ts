import pkg from '../package.json' with { type: 'json' }

export const VERSION = pkg.version

export { StripeSync } from './stripeSync'

export type * from './types'

export { PostgresClient } from './database/postgres'
export { createSyncClient, BaseSyncClient } from './database/createSyncClient'
export { runMigrations } from './database/migrate'
export type { DatabaseType, SyncDatabaseClient } from './database/SyncDatabaseClient'
export { generateSchema, migrateSchema, STRIPE_TABLES, getTableName } from './database/schema'
export { hashApiKey } from './utils/hashApiKey'
export { createStripeWebSocketClient } from './websocket-client'
export type {
  StripeWebSocketOptions,
  StripeWebSocketClient,
  StripeWebhookEvent,
  WebhookProcessingResult,
} from './websocket-client'
