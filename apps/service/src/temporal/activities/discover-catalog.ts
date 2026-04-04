import { applySelection, buildCatalog, parseNdjsonStream } from '@stripe/sync-engine'
import type { ConfiguredCatalog } from '@stripe/sync-engine'
import { collectMessages } from '@stripe/sync-protocol'
import type { DiscoverOutput, Message } from '@stripe/sync-protocol'

import type { ActivitiesContext } from './_shared.js'
import { pipelineHeader } from './_shared.js'

export function createDiscoverCatalogActivity(context: ActivitiesContext) {
  return async function discoverCatalog(pipelineId: string): Promise<ConfiguredCatalog> {
    const pipeline = await context.pipelines.get(pipelineId)
    const { id: _, ...config } = pipeline
    const response = await fetch(`${context.engineUrl}/discover`, {
      method: 'POST',
      headers: { 'x-pipeline': pipelineHeader(config) },
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`Engine /discover failed (${response.status}): ${text}`)
    }
    const {
      messages: [catalogMsg],
    } = await collectMessages(
      parseNdjsonStream<DiscoverOutput>(response.body!) as AsyncIterable<Message>,
      'catalog'
    )
    if (!catalogMsg) throw new Error('discover stream ended without emitting a catalog message')
    return applySelection(buildCatalog(catalogMsg.catalog.streams, config.streams))
  }
}
