import { createActivitiesContext } from './activities/_shared.js'
import { createDiscoverCatalogActivity } from './activities/discover-catalog.js'
import { createReadIntoQueueActivity } from './activities/read-into-queue.js'
import { createReadIntoQueueWithStateActivity } from './activities/read-into-queue-with-state.js'
import { createSetupActivity } from './activities/setup.js'
import { createSyncImmediateActivity } from './activities/sync-immediate.js'
import { createTeardownActivity } from './activities/teardown.js'
import { createWriteFromQueueActivity } from './activities/write-from-queue.js'
import { createWriteGoogleSheetsFromQueueActivity } from './activities/write-google-sheets-from-queue.js'

export type { RunResult } from './activities/_shared.js'

export function createActivities(opts: { engineUrl: string; kafkaBroker?: string }) {
  const context = createActivitiesContext(opts)

  return {
    discoverCatalog: createDiscoverCatalogActivity(context),
    setup: createSetupActivity(context),
    syncImmediate: createSyncImmediateActivity(context),
    readIntoQueueWithState: createReadIntoQueueWithStateActivity(context),
    readIntoQueue: createReadIntoQueueActivity(context),
    writeGoogleSheetsFromQueue: createWriteGoogleSheetsFromQueueActivity(context),
    writeFromQueue: createWriteFromQueueActivity(context),
    teardown: createTeardownActivity(context),
  }
}

export type SyncActivities = ReturnType<typeof createActivities>
