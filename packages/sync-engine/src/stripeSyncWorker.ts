import Stripe from 'stripe'
import { PostgresClient } from './database/postgres'
import { ProcessNextResult, ResourceConfig, StripeSyncConfig } from './types'
import { StripeObject } from './resourceRegistry'
import { SigmaSyncProcessor } from './sigma/sigmaSyncProcessor'
import { RunKey } from './stripeSync'

export type SyncTask = {
  object: StripeObject
  cursor: string | null
  pageCursor: string | null
}

export class StripeSyncWorker {
  private running = false
  private loopPromise: Promise<void> | null = null

  constructor(
    private readonly stripe: Stripe,
    private readonly config: StripeSyncConfig,
    private readonly sigma: SigmaSyncProcessor,
    private readonly postgresClient: PostgresClient,
    private readonly accountId: string,
    private readonly resourceRegistry: Record<StripeObject, ResourceConfig>,
    private readonly runKey: RunKey
  ) {}

  start(): void {
    if (this.running) return
    this.running = true
    this.loopPromise = this.loop()
  }

  async shutdown(): Promise<void> {
    this.running = false
    await this.loopPromise
  }

  private async loop(): Promise<void> {
    while (this.running) {
      if (!this.running) break

      const task = await this.getNextTask()
      if (!task) {
        this.running = false
        break
      }
      await this.processSingleTask(task)
    }
  }

  async waitUntilDone(): Promise<void> {
    await this.loopPromise
  }

  async fetchOnePage(
    object: string,
    cursor: string | null,
    pageCursor: string | null,
    config: ResourceConfig
  ) {
    if (config.sigma)
      throw new Error(`Sigma sync not supported in worker (config: ${JSON.stringify(config)})`)
    const listParams: Stripe.PaginationParams & { created?: Stripe.RangeQueryParam } = {
      limit: 100,
    }
    if (config.supportsCreatedFilter) {
      const created =
        cursor && /^\d+$/.test(cursor) ? ({ gte: Number.parseInt(cursor, 10) } as const) : undefined
      if (created) {
        listParams.created = created
      }
    }

    // Add pagination cursor (object ID) if present
    if (pageCursor) {
      listParams.starting_after = pageCursor
    }

    // Fetch from Stripe
    const response = await config.listFn(listParams)
    return response
  }

  async getNextTask(): Promise<SyncTask | null> {
    const { accountId, runStartedAt } = this.runKey

    // Atomically claim the next pending task (FOR UPDATE SKIP LOCKED).
    const claimed = await this.postgresClient.claimNextTask(accountId, runStartedAt)
    if (!claimed) return null

    const object = claimed.object as StripeObject
    const cursor = await this.postgresClient.getLastCursorBeforeRun(accountId, object, runStartedAt)
    return { object, cursor, pageCursor: claimed.pageCursor }
  }

  async updateTaskProgress(
    task: SyncTask,
    data: Stripe.Response<Stripe.ApiList<unknown>>['data'],
    has_more: boolean
  ) {
    // Update progress
    const total = await this.postgresClient.incrementObjectProgress(
      this.accountId,
      this.runKey.runStartedAt,
      task.object,
      data.length
    )
    console.log(`[${task.object}] progress: ${total} total records synced`)

    // Update cursor with max created from this batch
    const maxCreated = Math.max(...data.map((i) => (i as { created?: number }).created || 0))

    if (maxCreated > 0) {
      await this.postgresClient.updateObjectCursor(
        this.accountId,
        this.runKey.runStartedAt,
        task.object,
        String(maxCreated)
      )
    }

    // Update pagination page_cursor and mark back as pending for next claim
    if (has_more && data.length > 0) {
      const lastId = (data[data.length - 1] as { id: string }).id
      await this.postgresClient.releaseObjectSync(
        this.accountId,
        this.runKey.runStartedAt,
        task.object,
        lastId
      )
    }

    // Mark complete if no more pages
    if (!has_more) {
      await this.postgresClient.completeObjectSync(
        this.accountId,
        this.runKey.runStartedAt,
        task.object
      )
    }
  }

  async processSingleTask(task: SyncTask): Promise<ProcessNextResult> {
    const config = Object.entries(this.resourceRegistry).find(
      ([_, cfg]) => cfg.tableName === task.object && cfg.sigma === undefined
    )?.[1]
    if (!config) throw new Error(`Unsupported object type for processSingleTask: ${task.object}`)
    const { data, has_more } = await this.fetchOnePage(
      task.object,
      task.cursor,
      task.pageCursor,
      config
    )
    if (data.length === 0 && has_more) {
      await this.postgresClient.failObjectSync(
        this.accountId,
        this.runKey.runStartedAt,
        task.object,
        'Stripe returned has_more=true with empty page'
      )
    } else if (data.length > 0) {
      await config.upsertFn!(data, this.accountId, false)
    }
    console.log(`Synced: ${task.object} ${data.length}`)

    await this.updateTaskProgress(task, data, has_more)
    return { hasMore: has_more, processed: data.length, runStartedAt: this.runKey.runStartedAt }
  }
}
