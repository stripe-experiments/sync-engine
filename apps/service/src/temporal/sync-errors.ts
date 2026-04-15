export type SyncRunError = {
  message: string
  failure_type?: string
  stream?: string
}

export type ClassifiedSyncErrors = {
  transient: SyncRunError[]
  permanent: SyncRunError[]
  /** Permanent errors without a stream scope — bad API key, invalid config. Parks the workflow. */
  globalPermanent: SyncRunError[]
  /** Permanent errors scoped to a single stream — feature gate, per-stream auth. Stream is skipped on resume. */
  streamPermanent: SyncRunError[]
}

const PERMANENT_FAILURE_TYPES = new Set(['config_error', 'auth_error', 'system_error'])

export function classifySyncErrors(errors: SyncRunError[]): ClassifiedSyncErrors {
  const transient: SyncRunError[] = []
  const permanent: SyncRunError[] = []
  const globalPermanent: SyncRunError[] = []
  const streamPermanent: SyncRunError[] = []

  for (const error of errors) {
    if (PERMANENT_FAILURE_TYPES.has(error.failure_type ?? '')) {
      permanent.push(error)
      if (error.stream) {
        streamPermanent.push(error)
      } else {
        globalPermanent.push(error)
      }
    } else {
      transient.push(error)
    }
  }

  return { transient, permanent, globalPermanent, streamPermanent }
}

export function summarizeSyncErrors(errors: SyncRunError[]): string {
  return errors
    .map((error) => {
      const failureType = error.failure_type ?? 'unknown_error'
      const stream = error.stream ? `/${error.stream}` : ''
      return `[${failureType}${stream}] ${error.message}`
    })
    .join('; ')
}
