import { defineSignal, proxyActivities } from '@temporalio/workflow'

import type { SyncActivities } from '../activities/index.js'
import { retryPolicy } from '../../lib/utils.js'

export type RowIndex = Record<string, Record<string, number>>

export const stripeEventSignal = defineSignal<[unknown]>('stripe_event')
/** Generic "pipeline was updated" signal — workflow re-reads config from store. */
export const updateSignal = defineSignal('update')

export const { setup, teardown } = proxyActivities<SyncActivities>({
  startToCloseTimeout: '2m',
  retry: retryPolicy,
})

export const { syncImmediate } = proxyActivities<SyncActivities>({
  startToCloseTimeout: '10m',
  heartbeatTimeout: '2m',
  retry: retryPolicy,
})

export const { discoverCatalog, readGoogleSheetsIntoQueue, writeGoogleSheetsFromQueue } =
  proxyActivities<SyncActivities>({
    startToCloseTimeout: '10m',
    heartbeatTimeout: '2m',
    retry: retryPolicy,
  })

export const { getDesiredStatus, updateWorkflowStatus } = proxyActivities<SyncActivities>({
  startToCloseTimeout: '30s',
  retry: retryPolicy,
})
