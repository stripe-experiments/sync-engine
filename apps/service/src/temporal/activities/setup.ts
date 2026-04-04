import type { SetupResult } from '@stripe/sync-engine'
import { collectMessages } from '@stripe/sync-protocol'
import type { Message } from '@stripe/sync-protocol'

import type { ActivitiesContext } from './_shared.js'

export function createSetupActivity(context: ActivitiesContext) {
  return async function setup(pipelineId: string): Promise<SetupResult> {
    const pipeline = await context.pipelines.get(pipelineId)
    const { id: _, ...config } = pipeline
    const { messages: controlMsgs } = await collectMessages(
      context.engine.pipeline_setup(config) as AsyncIterable<Message>,
      'control'
    )
    const result: SetupResult = {}
    const sourceConfigs = controlMsgs
      .filter((m) => m._emitted_by?.startsWith('source/'))
      .map((m) => m.control.config)
    const destConfigs = controlMsgs
      .filter((m) => m._emitted_by?.startsWith('destination/'))
      .map((m) => m.control.config)
    if (sourceConfigs.length > 0) result.source = Object.assign({}, ...sourceConfigs)
    if (destConfigs.length > 0) result.destination = Object.assign({}, ...destConfigs)
    // Persist any config mutations (e.g. webhook endpoint IDs) back to the store
    if (result.source || result.destination) {
      const patch: Record<string, unknown> = {}
      if (result.source) patch.source = { ...pipeline.source, ...result.source }
      if (result.destination) patch.destination = { ...pipeline.destination, ...result.destination }
      await context.pipelines.update(pipelineId, patch)
    }
    return result
  }
}
