import sourceStripe from '@stripe/sync-source-stripe'
import destinationPostgres from '@stripe/sync-destination-postgres'
import destinationSqlite from '@stripe/sync-destination-sqlite'
import destinationGoogleSheets from '@stripe/sync-destination-google-sheets'
import type { RegisteredConnectors } from './resolver.js'

/** Default in-process connectors bundled with the engine. */
export const defaultConnectors: RegisteredConnectors = {
  sources: { stripe: sourceStripe },
  destinations: {
    postgres: destinationPostgres,
    sqlite: destinationSqlite,
    google_sheets: destinationGoogleSheets,
  },
}
