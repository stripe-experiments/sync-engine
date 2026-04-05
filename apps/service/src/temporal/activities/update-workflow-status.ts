import type { WorkflowStatus } from '../../lib/createSchemas.js'
import type { ActivitiesContext } from './_shared.js'

export function createUpdateWorkflowStatusActivity(context: ActivitiesContext) {
  return async function updateWorkflowStatus(
    pipelineId: string,
    workflowStatus: WorkflowStatus
  ): Promise<void> {
    try {
      await context.pipelineStore.update(pipelineId, { workflow_status: workflowStatus })
    } catch {
      // Pipeline may have been removed — no-op
    }
  }
}
