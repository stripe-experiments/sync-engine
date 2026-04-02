import {
  proxyActivities,
  defineSignal,
  defineQuery,
  setHandler,
  condition,
  continueAsNew,
  sleep,
} from '@temporalio/workflow'

import type { SyncActivities } from './activities.js'
import type { WorkflowStatus } from './types.js'

const CONTINUE_AS_NEW_THRESHOLD = 500

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    const bArr = b as unknown[]
    return a.length === bArr.length && a.every((v, i) => deepEqual(v, bArr[i]))
  }
  const aKeys = Object.keys(a as object)
  const bKeys = Object.keys(b as object)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((k) =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
  )
}
const EVENT_BATCH_SIZE = 50

const retryPolicy = {
  initialInterval: '1s',
  backoffCoefficient: 2.0,
  maximumInterval: '5m',
  maximumAttempts: 10,
} as const

// Setup/teardown: 2m with retry
const { setup, teardown } = proxyActivities<SyncActivities>({
  startToCloseTimeout: '2m',
  retry: retryPolicy,
})

// Data activities: 10m with retry and heartbeat
const { sync, read, write } = proxyActivities<SyncActivities>({
  startToCloseTimeout: '10m',
  heartbeatTimeout: '2m',
  retry: retryPolicy,
})

// Signals
export const stripeEventSignal = defineSignal<[unknown]>('stripe_event')
export const pauseSignal = defineSignal('pause')
export const resumeSignal = defineSignal('resume')
export const deleteSignal = defineSignal('delete')

// Query
export const statusQuery = defineQuery<WorkflowStatus>('status')

export async function pipelineWorkflow(
  pipelineId: string,
  opts?: {
    phase?: string
    state?: Record<string, unknown>
    mode?: 'sync' | 'read-write'
    writeRps?: number
    pendingWrites?: boolean
    inputQueue?: unknown[]
  }
): Promise<void> {
  let paused = false
  let deleted = false
  const inputQueue: unknown[] = [...(opts?.inputQueue ?? [])]
  let iteration = 0
  let syncState: Record<string, unknown> = opts?.state ?? {}
  let reconciled = false
  let pendingWrites = opts?.pendingWrites ?? false

  // Register signal handlers (must be before any await)
  setHandler(stripeEventSignal, (event: unknown) => {
    inputQueue.push(event)
  })
  setHandler(pauseSignal, () => {
    paused = true
  })
  setHandler(resumeSignal, () => {
    paused = false
  })
  setHandler(deleteSignal, () => {
    deleted = true
  })

  // Register query handler
  const phase = opts?.phase ?? 'setup'
  setHandler(
    statusQuery,
    (): WorkflowStatus => ({
      phase: phase === 'setup' && iteration > 0 ? 'running' : phase,
      paused,
      iteration,
    })
  )

  // --- Helpers ---

  async function waitWhilePaused() {
    await condition(() => !paused || deleted)
  }

  async function tickIteration() {
    iteration++
    if (iteration >= CONTINUE_AS_NEW_THRESHOLD) {
      await continueAsNew<typeof pipelineWorkflow>(pipelineId, {
        phase: 'running',
        state: syncState,
        mode: opts?.mode,
        writeRps: opts?.writeRps,
        pendingWrites,
        inputQueue: inputQueue.length > 0 ? [...inputQueue] : undefined,
      })
    }
  }

  // --- Setup (first sync only) ---

  if (phase !== 'running') {
    await setup(pipelineId)
    if (deleted) {
      await teardown(pipelineId)
      return
    }
  }

  // --- Main loop ---

  if (opts?.mode === 'read-write') {
    // Concurrent read/write via Kafka queue — each loop runs at its own pace

    async function readLoop(): Promise<void> {
      while (!deleted) {
        await waitWhilePaused()
        if (deleted) break

        // Resolve events through read → Kafka
        if (inputQueue.length > 0) {
          const batch = inputQueue.splice(0, EVENT_BATCH_SIZE)
          const { count } = await read(pipelineId, { input: batch })
          if (count > 0) pendingWrites = true
          await tickIteration()
          continue
        }

        // Reconciliation: backfill one page → Kafka
        if (!reconciled) {
          const before = syncState
          const { count, state: readState } = await read(pipelineId, {
            state: syncState,
            stateLimit: 1,
          })
          if (count > 0) pendingWrites = true
          syncState = { ...syncState, ...readState }
          reconciled = deepEqual(syncState, before)
          await tickIteration()
          continue
        }

        // All caught up — wait for new events or delete
        await condition(() => inputQueue.length > 0 || deleted)
      }
    }

    async function writeLoop(): Promise<void> {
      while (!deleted) {
        await waitWhilePaused()
        if (deleted) break

        if (pendingWrites) {
          const result = await write(pipelineId, { maxBatch: 50 })
          pendingWrites = result.written > 0
          if (opts?.writeRps) await sleep(Math.ceil(1000 / opts.writeRps))
          await tickIteration()
        } else {
          // Wait until there's something to write or we're done
          await condition(() => pendingWrites || deleted)
        }
      }
    }

    await Promise.all([readLoop(), writeLoop()])
  } else {
    // sync mode: combined read+write in a single activity call

    while (true) {
      await waitWhilePaused()
      if (deleted) break

      // 1. Drain buffered events
      if (inputQueue.length > 0) {
        const batch = inputQueue.splice(0, EVENT_BATCH_SIZE)
        await sync(pipelineId, { input: batch })
        await tickIteration()
        continue
      }

      // 2. Reconciliation page
      if (!reconciled) {
        const before = syncState
        const result = await sync(pipelineId, { state: syncState, stateLimit: 1 })
        syncState = { ...syncState, ...result.state }
        reconciled = deepEqual(syncState, before)
        await tickIteration()
        continue
      }

      // 3. Wait
      await condition(() => inputQueue.length > 0 || deleted)
    }
  }

  // Teardown on delete
  await teardown(pipelineId)
}
