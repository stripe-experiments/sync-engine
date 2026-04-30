import sourceStripe from '@stripe/sync-source-stripe'
import sourceMetronome from '@stripe/sync-source-metronome'
import destinationPostgres from '@stripe/sync-destination-postgres'
import destinationGoogleSheets from '@stripe/sync-destination-google-sheets'
import destinationRedis from '@stripe/sync-destination-redis'
import type { RegisteredConnectors } from './resolver.js'

/** Default in-process connectors bundled with the engine. */
export const defaultConnectors: RegisteredConnectors = {
  sources: { stripe: sourceStripe, metronome: sourceMetronome },
  destinations: {
    postgres: destinationPostgres,
    google_sheets: destinationGoogleSheets,
    redis: destinationRedis,
  },
}
