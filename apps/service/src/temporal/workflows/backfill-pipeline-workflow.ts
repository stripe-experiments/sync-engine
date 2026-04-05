import { condition, continueAsNew, setHandler } from '@temporalio/workflow'

import { getDesiredStatus, syncImmediate, updateSignal, updateWorkflowStatus } from './_shared.js'
import type { SourceState as SyncState } from '@stripe/sync-protocol'
import { CONTINUE_AS_NEW_THRESHOLD } from '../../lib/utils.js'

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000

export interface BackfillPipelineWorkflowOpts {
  state?: SyncState
}

export async function backfillPipelineWorkflow(
  pipelineId: string,
  opts?: BackfillPipelineWorkflowOpts
): Promise<void> {
  let desiredStatus = 'active'
  let updated = false
  let iteration = 0
  let syncState: SyncState = opts?.state ?? { streams: {}, global: {} }
  let backfillComplete = false

  setHandler(updateSignal, () => {
    updated = true
  })

  async function refreshDesiredStatus() {
    if (!updated) return
    updated = false
    desiredStatus = await getDesiredStatus(pipelineId)
  }

  async function maybeContinueAsNew() {
    if (++iteration >= CONTINUE_AS_NEW_THRESHOLD) {
      await continueAsNew<typeof backfillPipelineWorkflow>(pipelineId, { state: syncState })
    }
  }

  await updateWorkflowStatus(pipelineId, 'backfill')

  while (desiredStatus !== 'deleted') {
    await refreshDesiredStatus()

    if (desiredStatus === 'deleted') break

    if (desiredStatus === 'paused') {
      await updateWorkflowStatus(pipelineId, 'paused')
      await condition(() => updated)
      continue
    }

    if (backfillComplete) {
      await updateWorkflowStatus(pipelineId, 'ready')
      const timedOut = !(await condition(() => updated, ONE_WEEK_MS))
      if (timedOut) backfillComplete = false
      continue
    }

    const result = await syncImmediate(pipelineId, {
      state: syncState,
      state_limit: 100,
      time_limit: 10,
    })
    syncState = {
      streams: { ...syncState.streams, ...result.state.streams },
      global: { ...syncState.global, ...result.state.global },
    }
    backfillComplete = result.eof?.reason === 'complete'
    await maybeContinueAsNew()
  }

  await updateWorkflowStatus(pipelineId, 'teardown')
}
