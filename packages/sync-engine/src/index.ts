import pkg from '../package.json' with { type: 'json' }

export const VERSION = pkg.version

export { StripeSync } from './stripeSync'

export type * from './types'

export { PostgresClient } from './database/postgres'
export { hashApiKey } from './utils/hashApiKey'

// Database adapter interface (use stripe-experiment-sync/pg or stripe-experiment-sync/postgres-js for implementations)
export type { DatabaseAdapter } from './database/adapter'

// Note: runMigrations is exported from 'stripe-experiment-sync/pg' since it uses pg directly
