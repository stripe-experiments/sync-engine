import pkg from '../package.json' with { type: 'json' }

export const VERSION = pkg.version

export { StripeSync } from './stripeSync'
export { StripeSyncWorker } from './stripeSyncWorker'
export { getTableName } from './resourceRegistry'

export type * from './types'

export { PostgresClient } from './database/postgres'
export {
  buildSchemaComment,
  parseSchemaComment,
  STRIPE_SCHEMA_COMMENT_PREFIX,
  INSTALLATION_STARTED_SUFFIX,
  INSTALLATION_ERROR_SUFFIX,
  INSTALLATION_INSTALLED_SUFFIX,
  UNINSTALLATION_STARTED_SUFFIX,
  UNINSTALLATION_ERROR_SUFFIX,
} from './stripeComment'
export { runMigrations, runMigrationsFromContent } from './database/migrate'
export { embeddedMigrations } from './database/migrations-embedded'
export type { EmbeddedMigration } from './database/migrations-embedded'
export { hashApiKey } from './utils/hashApiKey'
export { createStripeWebSocketClient } from './websocket-client'
export type {
  StripeWebSocketOptions,
  StripeWebSocketClient,
  StripeWebhookEvent,
  WebhookProcessingResult,
} from './websocket-client'
