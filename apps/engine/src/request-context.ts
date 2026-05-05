import { getEngineRequestId, runWithLogContext } from '@stripe/sync-logger'

export const ENGINE_REQUEST_ID_HEADER = 'sync-engine-request-id'
export const ENGINE_INTERNAL_REQUEST_HEADER = 'x-sync-engine-internal-request'

type EngineRequestContext = {
  engineRequestId: string
  action_id: string | null
  run_id: string | null
}

export function runWithEngineRequestContext<T>(context: EngineRequestContext, fn: () => T): T {
  return runWithLogContext(context, fn)
}

export { getEngineRequestId }
