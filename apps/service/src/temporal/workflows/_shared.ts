import { defineSignal, proxyActivities } from '@temporalio/workflow'

import type { SyncActivities } from '../activities/index.js'
import { retryPolicy } from '../../lib/utils.js'
import { SourceInputMessage } from '@stripe/sync-protocol'

export const sourceInputSignal = defineSignal<[SourceInputMessage]>('source_input')
/** Pause or resume the pipeline. true = paused, false = active. */
export const pausedSignal = defineSignal<[boolean]>('paused')

export const { pipelineSetup, pipelineTeardown } = proxyActivities<SyncActivities>({
  startToCloseTimeout: '2m',
  retry: retryPolicy,
})

export const { pipelineSync } = proxyActivities<SyncActivities>({
  startToCloseTimeout: '10m',
  heartbeatTimeout: '2m',
  retry: retryPolicy,
})

export const { reconcileCleanup } = proxyActivities<SyncActivities>({
  startToCloseTimeout: '1h', // Could take a while due to rate limiting
  heartbeatTimeout: '2m',
  retry: retryPolicy,
})

export const { discoverCatalog } = proxyActivities<SyncActivities>({
  startToCloseTimeout: '10m',
  heartbeatTimeout: '2m',
  retry: retryPolicy,
})

export const { updatePipelineStatus } = proxyActivities<SyncActivities>({
  startToCloseTimeout: '30s',
  retry: retryPolicy,
})
