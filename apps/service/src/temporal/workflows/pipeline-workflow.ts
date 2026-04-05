import { condition, continueAsNew, setHandler } from '@temporalio/workflow'

import {
  desiredStatusSignal,
  setup,
  stripeEventSignal,
  syncImmediate,
  teardown,
  updateWorkflowStatus,
} from './_shared.js'
import { CONTINUE_AS_NEW_THRESHOLD, EVENT_BATCH_SIZE } from '../../lib/utils.js'
import type { SourceInput, SourceState as SyncState } from '@stripe/sync-protocol'

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000

export interface PipelineWorkflowOpts {
  desiredStatus?: string
  state?: SyncState
  inputQueue?: SourceInput[]
}

export async function pipelineWorkflow(
  pipelineId: string,
  opts?: PipelineWorkflowOpts
): Promise<void> {
  let desiredStatus = opts?.desiredStatus ?? 'active'
  const inputQueue: unknown[] = [...(opts?.inputQueue ?? [])]
  let iteration = 0
  let syncState: SyncState = opts?.state ?? { streams: {}, global: {} }
  let readComplete = false

  setHandler(stripeEventSignal, (event: unknown) => {
    inputQueue.push(event)
  })
  setHandler(desiredStatusSignal, (status: string) => {
    desiredStatus = status
  })

  async function maybeContinueAsNew() {
    if (++iteration >= CONTINUE_AS_NEW_THRESHOLD) {
      await continueAsNew<typeof pipelineWorkflow>(pipelineId, {
        desiredStatus,
        state: syncState,
        inputQueue: inputQueue.length > 0 ? [...inputQueue] : undefined,
      })
    }
  }

  // Setup
  await setup(pipelineId)
  await updateWorkflowStatus(pipelineId, 'backfill')

  if (desiredStatus === 'deleted') {
    await updateWorkflowStatus(pipelineId, 'teardown')
    await teardown(pipelineId)
    return
  }

  while (desiredStatus !== 'deleted') {
    if (desiredStatus === 'paused') {
      await updateWorkflowStatus(pipelineId, 'paused')
      await condition(() => desiredStatus !== 'paused')
      continue
    }

    // Resuming from paused — update status
    if (readComplete) {
      await updateWorkflowStatus(pipelineId, 'ready')
    } else {
      await updateWorkflowStatus(pipelineId, 'backfill')
    }

    if (readComplete && inputQueue.length === 0) {
      // Idle — wait up to one week; timeout means recon is due.
      const timedOut = !(await condition(() => desiredStatus !== 'active' || inputQueue.length > 0, ONE_WEEK_MS))
      if (timedOut) readComplete = false
      continue
    }

    if (inputQueue.length > 0) {
      const batch = inputQueue.splice(0, EVENT_BATCH_SIZE)
      await syncImmediate(pipelineId, { input: batch })
    } else {
      const result = await syncImmediate(pipelineId, {
        state: syncState,
        state_limit: 100,
        time_limit: 10,
      })
      syncState = {
        streams: { ...syncState.streams, ...result.state.streams },
        global: { ...syncState.global, ...result.state.global },
      }
      if (result.eof?.reason === 'complete') {
        readComplete = true
        await updateWorkflowStatus(pipelineId, 'ready')
      }
    }

    await maybeContinueAsNew()
  }

  await updateWorkflowStatus(pipelineId, 'teardown')
  await teardown(pipelineId)
}
