import { condition, continueAsNew, setHandler } from '@temporalio/workflow'

import {
  configQuery,
  deleteSignal,
  Pipeline,
  stateQuery,
  statusQuery,
  syncImmediate,
  toConfig,
  updateSignal,
  WorkflowStatus,
} from './_shared.js'
import { CONTINUE_AS_NEW_THRESHOLD } from '../../lib/utils.js'

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000

export interface SimplestPipelineWorkflowOpts {
  state?: Record<string, unknown>
  reconInterval?: number
}

export async function simplestPipelineWorkflow(
  pipeline: Pipeline,
  opts?: SimplestPipelineWorkflowOpts
): Promise<void> {
  let paused = false
  let deleted = false
  let iteration = 0
  let syncState: Record<string, unknown> = opts?.state ?? {}
  let readComplete = false

  setHandler(updateSignal, (patch: Partial<Pipeline>) => {
    if (patch.source) pipeline = { ...pipeline, source: patch.source }
    if (patch.destination) pipeline = { ...pipeline, destination: patch.destination }
    if (patch.streams !== undefined) pipeline = { ...pipeline, streams: patch.streams }
    if ('paused' in (patch as Record<string, unknown>)) {
      paused = !!(patch as Record<string, unknown>).paused
    }
  })
  setHandler(deleteSignal, () => {
    deleted = true
  })

  setHandler(statusQuery, (): WorkflowStatus => ({ phase: 'running', paused, iteration }))
  setHandler(configQuery, (): Pipeline => pipeline)
  setHandler(stateQuery, (): Record<string, unknown> => syncState)

  async function tickIteration() {
    iteration++
    if (iteration >= CONTINUE_AS_NEW_THRESHOLD) {
      await continueAsNew<typeof simplestPipelineWorkflow>(pipeline, {
        state: syncState,
        reconInterval: opts?.reconInterval,
      })
    }
  }

  while (!deleted) {
    await condition(() => !paused || deleted)
    if (deleted) break

    if (!readComplete) {
      const result = await syncImmediate(toConfig(pipeline), {
        state: syncState,
        stateLimit: 1,
      })
      syncState = { ...syncState, ...result.state }
      readComplete = result.eof?.reason === 'complete'
      await tickIteration()
      continue
    }

    // Backfill complete — wait for recon interval then re-sync from latest state.
    const gotSignal = await condition(() => !paused || deleted, opts?.reconInterval ?? ONE_WEEK_MS)
    if (!gotSignal && !deleted) readComplete = false
  }
}
