import type { ActivitiesContext } from './_shared.js'

export function createGetDesiredStatusActivity(context: ActivitiesContext) {
  return async function getDesiredStatus(pipelineId: string): Promise<string> {
    const pipeline = await context.pipelineStore.get(pipelineId)
    return pipeline.desired_status ?? 'active'
  }
}
