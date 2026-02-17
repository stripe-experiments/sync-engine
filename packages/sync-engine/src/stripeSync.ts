import Stripe from 'stripe'
import { pg as sql } from 'yesql'
import pkg from '../package.json' with { type: 'json' }
import { PostgresClient } from './database/postgres'
import {
  StripeSyncConfig,
  SyncBackfill,
  SyncParams,
  ProcessNextResult,
  ProcessNextParams,
  SyncObject,
  type ResourceConfig,
} from './types'
import { type PoolConfig } from 'pg'
import { hashApiKey } from './utils/hashApiKey'
import { expandEntity } from './utils/expandEntity'
import { SigmaSyncProcessor } from './sigma/sigmaSyncProcessor'
import { StripeSyncWebhook } from './stripeSyncWebhook'
import {
  buildResourceRegistry,
  getResourceConfigFromId,
  getTableName,
  StripeObject,
} from './resourceRegistry'
import { StripeSyncWorker } from './stripeSyncWorker'

/**
 * Identifies a specific sync run.
 */
export type RunKey = {
  accountId: string
  runStartedAt: Date
}

function getUniqueIds<T>(entries: T[], key: string): string[] {
  const set = new Set(
    entries
      .map((subscription) => subscription?.[key as keyof T]?.toString())
      .filter((it): it is string => Boolean(it))
  )

  return Array.from(set)
}

export class StripeSync {
  stripe: Stripe
  postgresClient: PostgresClient
  config: StripeSyncConfig
  readonly resourceRegistry: Record<StripeObject, ResourceConfig>
  webhook!: StripeSyncWebhook
  readonly sigma: SigmaSyncProcessor
  accountId!: string

  get sigmaSchemaName(): string {
    return this.sigma.sigmaSchemaName
  }

  private constructor(config: StripeSyncConfig) {
    this.config = config
    this.stripe = new Stripe(config.stripeSecretKey, {
      // https://github.com/stripe/stripe-node#configuration
      // @ts-ignore
      apiVersion: config.stripeApiVersion,
      maxNetworkRetries: 5,
      appInfo: {
        name: 'Stripe Sync Engine',
        version: pkg.version,
        url: pkg.homepage,
        ...(config.partnerId ? { partner_id: config.partnerId } : {}),
      },
    })

    this.config.logger = config.logger ?? console
    this.config.logger?.info(
      { autoExpandLists: config.autoExpandLists, stripeApiVersion: config.stripeApiVersion },
      'StripeSync initialized'
    )

    const poolConfig = config.poolConfig ?? ({} as PoolConfig)

    if (config.databaseUrl) {
      poolConfig.connectionString = config.databaseUrl
    }

    if (config.maxPostgresConnections) {
      poolConfig.max = config.maxPostgresConnections
    }

    if (poolConfig.max === undefined) {
      poolConfig.max = 10
    }

    if (poolConfig.keepAlive === undefined) {
      poolConfig.keepAlive = true
    }

    this.postgresClient = new PostgresClient({
      schema: 'stripe',
      poolConfig,
    })

    this.sigma = new SigmaSyncProcessor(this.postgresClient, {
      stripeSecretKey: config.stripeSecretKey,
      enableSigma: config.enableSigma,
      sigmaPageSizeOverride: config.sigmaPageSizeOverride,
      sigmaSchemaName: config.sigmaSchemaName,
      logger: this.config.logger,
    })

    this.resourceRegistry = buildResourceRegistry({
      stripe: this.stripe,
      upsertAny: this.upsertAny.bind(this),
      upsertSubscriptions: this.upsertSubscriptions.bind(this),
      sigma: this.sigma,
    })
  }

  /**
   * Create a new StripeSync instance. Resolves the default Stripe account,
   * stores it in the database, and makes the account ID available immediately.
   */
  static async create(config: StripeSyncConfig): Promise<StripeSync> {
    const instance = new StripeSync(config)
    const account = await instance.getCurrentAccount()
    if (!account) {
      throw new Error('Failed to retrieve Stripe account. Please ensure API key is valid.')
    }
    instance.accountId = account.id
    instance.webhook = new StripeSyncWebhook({
      stripe: instance.stripe,
      postgresClient: instance.postgresClient,
      config: instance.config,
      accountId: instance.accountId,
      getAccountId: instance.getAccountId.bind(instance),
      upsertAny: instance.upsertAny.bind(instance),
      resourceRegistry: instance.resourceRegistry,
    })
    return instance
  }

  /**
   * Get the Stripe account ID. Returns the default account ID, or resolves
   * a Connect sub-account ID when provided (Connect scenarios).
   */
  async getAccountId(objectAccountId?: string): Promise<string> {
    if (!objectAccountId) {
      return this.accountId
    }
    const account = await this.getCurrentAccount(objectAccountId)
    if (!account) {
      throw new Error('Failed to retrieve Stripe account. Please ensure API key is valid.')
    }
    return account.id
  }

  /**
   * Get the current account being synced. Uses database lookup by API key hash,
   * with fallback to Stripe API if not found (first-time setup or new API key).
   * @param objectAccountId - Optional account ID from event data (Connect scenarios)
   */
  async getCurrentAccount(objectAccountId?: string): Promise<Stripe.Account | null> {
    const apiKeyHash = hashApiKey(this.config.stripeSecretKey)

    // Try to lookup account from database using API key hash (fast path)
    try {
      const account = await this.postgresClient.getAccountByApiKeyHash(apiKeyHash)
      if (account) {
        return account as Stripe.Account
      }
    } catch (error) {
      this.config.logger?.warn(
        error,
        'Failed to lookup account by API key hash, falling back to API'
      )
    }

    // Not found in database - retrieve from Stripe API (first-time setup or new API key)
    try {
      const accountIdParam = objectAccountId || this.config.stripeAccountId
      const account = accountIdParam
        ? await this.stripe.accounts.retrieve(accountIdParam)
        : await this.stripe.accounts.retrieve()

      await this.postgresClient.upsertAccount({ id: account.id, raw_data: account }, apiKeyHash)
      return account
    } catch (error) {
      this.config.logger?.error(error, 'Failed to retrieve account from Stripe API')
      return null
    }
  }

  /**
   * Returns an array of all object types that can be synced via processNext/processUntilDone.
   * Ordered for backfill: parents before children (products before prices, customers before subscriptions).
   * Order is determined by the `order` field in resourceRegistry.
   */
  public getSupportedSyncObjects(): Exclude<SyncObject, 'all' | 'customer_with_entitlements'>[] {
    const all = Object.entries(this.resourceRegistry)
      .sort(([, a], [, b]) => a.order - b.order)
      .map(([key]) => key) as Exclude<SyncObject, 'all' | 'customer_with_entitlements'>[]

    // Only advertise Sigma-backed objects when explicitly enabled (opt-in).
    if (!this.config.enableSigma) {
      return all.filter((o) => !this.sigma.isSigmaResource(this.resourceRegistry, o)) as Exclude<
        SyncObject,
        'all' | 'customer_with_entitlements'
      >[]
    }

    return all
  }

  async syncSingleEntity(stripeId: string) {
    const accountId = this.accountId
    const resourceConfig = getResourceConfigFromId(stripeId, this.resourceRegistry)
    if (!resourceConfig || !resourceConfig.retrieveFn) {
      throw new Error(`Unsupported object type for syncSingleEntity: ${stripeId}`)
    }
    const item = await resourceConfig.retrieveFn(stripeId)
    await resourceConfig.upsertFn([item], accountId, false)
  }

  /**
   * Process one page of items for the specified object type.
   * Returns the number of items processed and whether there are more pages.
   *
   * This method is designed for queue-based consumption where each page
   * is processed as a separate job. Uses the observable sync system for tracking.
   *
   * @param object - The Stripe object type to sync (e.g., 'customer', 'product')
   * @param params - Optional parameters for filtering and run context
   * @returns ProcessNextResult with processed count, hasMore flag, and runStartedAt
   *
   * @example
   * ```typescript
   * // Queue worker
   * const { hasMore, runStartedAt } = await stripeSync.processNext('customer')
   * if (hasMore) {
   *   await queue.send({ object: 'customer', runStartedAt })
   * }
   * ```
   */
  async processNext(
    object: Exclude<SyncObject, 'all' | 'customer_with_entitlements'>,
    params?: ProcessNextParams
  ): Promise<ProcessNextResult> {
    try {
      const accountId = this.accountId

      // Map object type to resource name (database table)
      const resourceName = getTableName(object, this.resourceRegistry)

      // Get or create sync run
      let runStartedAt: Date
      if (params?.runStartedAt) {
        runStartedAt = params.runStartedAt
      } else {
        const run = await this.postgresClient.joinOrCreateSyncRun(
          this.accountId,
          params?.triggeredBy ?? 'processNext',
          [resourceName]
        )
        runStartedAt = run.runStartedAt
      }

      // Ensure object run exists
      await this.postgresClient.createObjectRuns(accountId, runStartedAt, [resourceName])

      // Check object status and try to claim if pending
      const objRun = await this.postgresClient.getObjectRun(accountId, runStartedAt, resourceName)
      if (objRun?.status === 'complete' || objRun?.status === 'error') {
        // Object already finished - return early
        return {
          processed: 0,
          hasMore: false,
          runStartedAt,
        }
      }

      // Try to start if pending (for first call on this object)
      if (objRun?.status === 'pending') {
        const started = await this.postgresClient.tryStartObjectSync(
          accountId,
          runStartedAt,
          resourceName
        )
        if (!started) {
          // At concurrency limit - return early
          return {
            processed: 0,
            hasMore: true,
            runStartedAt,
          }
        }
      }
      // If status is 'running', we continue processing (fetch next page)

      // Look up config from registry (needed to decide cursor semantics).
      const registryConfig = this.resourceRegistry[object]
      if (!registryConfig) {
        throw new Error(`Unsupported object type for processNext: ${object}`)
      }

      // Get cursor for incremental sync.
      // If user provided explicit created filter, use it
      // Otherwise, use the cursor from the last completed run.
      //
      // Note: Do not use the current run’s cursor as created.gte. That cursor while paging, and using it would keep jumping to newest-only, and can get stuck syncing ~100 rows forever.
      let cursor: string | null = null
      if (!params?.created) {
        const lastCursor = await this.postgresClient.getLastCursorBeforeRun(
          accountId,
          resourceName,
          runStartedAt
        )
        cursor = lastCursor ?? null
      }

      // Sigma paging uses the current run cursor to advance page-by-page.
      if (registryConfig.sigma && objRun?.cursor) {
        cursor = objRun.cursor
      }

      // Fetch one page and upsert
      const result = await this.fetchOnePage(
        object,
        accountId,
        resourceName,
        runStartedAt,
        cursor,
        objRun?.pageCursor ?? null,
        params
      )

      return result
    } catch (error) {
      throw new Error(`Error processing next page for ${object}: ${error}`)
    }
  }

  /**
   * Fetch one page of items from Stripe and upsert to database.
   * Uses resourceRegistry for DRY list/upsert operations.
   * Uses the observable sync system for tracking progress.
   */
  async fetchOnePage(
    object: Exclude<SyncObject, 'all' | 'customer_with_entitlements'>,
    accountId: string,
    resourceName: string,
    runStartedAt: Date,
    cursor: string | null,
    pageCursor: string | null,
    params?: ProcessNextParams
  ): Promise<ProcessNextResult> {
    const limit = 100 // Stripe page size

    // Handle special cases that require customer context
    if (object === 'payment_method' || object === 'tax_id') {
      this.config.logger?.warn(`processNext for ${object} requires customer context`)
      await this.postgresClient.completeObjectSync(accountId, runStartedAt, resourceName)
      return { processed: 0, hasMore: false, runStartedAt }
    }

    // Look up config from registry
    const config = this.resourceRegistry[object]
    if (!config) {
      throw new Error(`Unsupported object type for processNext: ${object}`)
    }

    if (config.sigma && !this.config.enableSigma) {
      throw new Error(`Sigma sync is disabled. Enable sigma to sync ${object}.`)
    }

    try {
      if (config.sigma) {
        return await this.sigma.fetchOneSigmaPage(
          accountId,
          resourceName,
          runStartedAt,
          cursor,
          config.sigma
        )
      }

      // Build list parameters
      const listParams: Stripe.PaginationParams & { created?: Stripe.RangeQueryParam } = { limit }
      if (config.supportsCreatedFilter) {
        const created =
          params?.created ??
          (cursor && /^\d+$/.test(cursor)
            ? ({ gte: Number.parseInt(cursor, 10) } as const)
            : undefined)
        if (created) {
          listParams.created = created
        }
      }

      // Add pagination cursor if present
      if (pageCursor) {
        listParams.starting_after = pageCursor
      }

      // Fetch from Stripe
      const response = await config.listFn(listParams)

      // Defensive: Stripe should not return has_more=true with empty data. Avoid infinite loops by failing this object run if it ever happens.
      if (response.data.length === 0 && response.has_more) {
        const message = `Stripe returned has_more=true with empty page for ${resourceName}. Aborting to avoid infinite loop.`
        this.config.logger?.warn(message)

        await this.postgresClient.failObjectSync(accountId, runStartedAt, resourceName, message)
        return { processed: 0, hasMore: false, runStartedAt }
      }

      // Upsert the data
      if (response.data.length > 0) {
        this.config.logger?.info(`processNext: upserting ${response.data.length} ${resourceName}`)
        await config.upsertFn(response.data, accountId, params?.backfillRelatedEntities)

        // Update progress
        await this.postgresClient.incrementObjectProgress(
          accountId,
          runStartedAt,
          resourceName,
          response.data.length
        )

        // Update cursor with max created from this batch
        const maxCreated = Math.max(
          ...response.data.map((i) => (i as { created?: number }).created || 0)
        )
        if (maxCreated > 0) {
          await this.postgresClient.updateObjectCursor(
            accountId,
            runStartedAt,
            resourceName,
            String(maxCreated)
          )
        }

        // Update pagination page_cursor with last item's ID
        const lastId = (response.data[response.data.length - 1] as { id: string }).id
        if (response.has_more) {
          await this.postgresClient.updateObjectPageCursor(
            accountId,
            runStartedAt,
            resourceName,
            lastId
          )
        }
      }

      // Mark complete if no more pages
      if (!response.has_more) {
        await this.postgresClient.completeObjectSync(accountId, runStartedAt, resourceName)
      }

      return {
        processed: response.data.length,
        hasMore: response.has_more,
        runStartedAt,
      }
    } catch (error) {
      await this.postgresClient.failObjectSync(
        accountId,
        runStartedAt,
        resourceName,
        error instanceof Error ? error.message : 'Unknown error'
      )
      throw error
    }
  }

  async fullResyncAll(): Promise<{
    results: SyncBackfill
    totals: Record<string, number>
    totalSynced: number
    skipped: string[]
    errors: Array<{ object: string; message: string }>
  }> {
    const objects = this.getSupportedSyncObjects()
    const tableNames = objects.map((obj) => getTableName(obj, this.resourceRegistry))
    const runKey = await this.postgresClient.joinOrCreateSyncRun(
      this.accountId,
      'fullResyncAll',
      tableNames
    )
    const workerCount = 10
    const workers = Array.from(
      { length: workerCount },
      () =>
        new StripeSyncWorker(
          this.stripe,
          this.config,
          this.sigma,
          this.postgresClient,
          this.accountId,
          this.resourceRegistry,
          runKey
        )
    )
    workers.forEach((worker) => worker.start())
    await Promise.all(workers.map((worker) => worker.waitUntilDone()))

    const totals = await this.postgresClient.getObjectSyncedCounts(
      this.accountId,
      runKey.runStartedAt
    )

    const results: SyncBackfill = {}
    const errors: Array<{ object: string; message: string }> = []
    for (const [obj, count] of Object.entries(totals)) {
      results[obj] = { synced: count }
    }
    const totalSynced = Object.values(totals).reduce((sum, count) => sum + count, 0)

    await this.postgresClient.closeSyncRun(runKey.accountId, runKey.runStartedAt)

    return { results, totals, totalSynced, skipped: [], errors }
  }

  async processUntilDoneParallel(
    params?: SyncParams & {
      maxParallel?: number
      triggeredBy?: string
      continueOnError?: boolean
      skipInaccessibleSigmaTables?: boolean
    }
  ): Promise<{
    results: SyncBackfill
    totals: Record<string, number>
    totalSynced: number
    skipped: string[]
    errors: Array<{ object: string; message: string }>
  }> {
    const {
      object,
      maxParallel,
      triggeredBy = 'processUntilDoneParallel',
      continueOnError = true,
      skipInaccessibleSigmaTables = false,
    } = params ?? {}

    const objectsToSync =
      object === 'all' || object === undefined
        ? this.getSupportedSyncObjects()
        : [object as Exclude<SyncObject, 'all' | 'customer_with_entitlements'>]
    const runKey = await this.postgresClient.joinOrCreateSyncRun(
      this.accountId,
      triggeredBy,
      objectsToSync.map((obj) => getTableName(obj, this.resourceRegistry))
    )
    const runConfig = await this.postgresClient.getSyncRun(runKey.accountId, runKey.runStartedAt)
    const maxConcurrent = runConfig?.maxConcurrent ?? 10
    const workerCount = Math.max(
      1,
      Math.min(objectsToSync.length, maxParallel ?? maxConcurrent, maxConcurrent)
    )

    const totals: Record<string, number> = {}
    for (const obj of objectsToSync) {
      totals[obj] = 0
    }

    const skipped: string[] = []
    const errors: Array<{ object: string; message: string }> = []
    const queue = [...objectsToSync]
    const shouldSkipInaccessibleTable = (message: string) =>
      message.includes('tables which do not exist or are inaccessible')

    const worker = async () => {
      while (true) {
        const obj = queue.shift()
        if (!obj) break

        try {
          let hasMore = true
          while (hasMore) {
            const result = await this.processNext(obj, {
              runStartedAt: runKey.runStartedAt,
              triggeredBy,
              created: params?.created,
              backfillRelatedEntities: params?.backfillRelatedEntities,
            })
            totals[obj] += result.processed
            hasMore = result.hasMore
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (skipInaccessibleSigmaTables && shouldSkipInaccessibleTable(message)) {
            skipped.push(obj)
            this.config.logger?.warn(`Skipping Sigma table ${obj}: not accessible for this account`)
            continue
          }
          errors.push({ object: obj, message })
          this.config.logger?.error(`Sync error for ${obj}: ${message}`)
          if (!continueOnError) {
            throw error
          }
        }
      }
    }

    try {
      const workers = Array.from({ length: workerCount }, () => worker())
      await Promise.all(workers)

      const results: SyncBackfill = {}
      for (const obj of objectsToSync) {
        results[obj] = { synced: totals[obj] ?? 0 }
      }

      const totalSynced = Object.values(totals).reduce((sum, count) => sum + count, 0)
      await this.postgresClient.closeSyncRun(runKey.accountId, runKey.runStartedAt)

      return { results, totals, totalSynced, skipped, errors }
    } catch (error) {
      await this.postgresClient.closeSyncRun(runKey.accountId, runKey.runStartedAt)
      throw error
    }
  }

  async processUntilDone(params?: SyncParams): Promise<SyncBackfill> {
    const { results } = await this.processUntilDoneParallel({
      ...params,
      maxParallel: 1,
      triggeredBy: 'processUntilDone',
    })
    return results
  }
  /**
   * Maps Stripe API object type strings (e.g. "checkout.session") to SyncObject keys
   * used in resourceRegistry and getTableName().
   */
  private static readonly STRIPE_OBJECT_TO_SYNC_OBJECT: Record<string, string> = {
    'checkout.session': 'checkout_sessions',
    'radar.early_fraud_warning': 'early_fraud_warning',
    'entitlements.active_entitlement': 'active_entitlements',
    'entitlements.feature': 'features',
    subscription_schedule: 'subscription_schedules',
  }

  /**
   * Convert a Stripe API object name (items[0].object) to a SyncObject-compatible key.
   * Handles dotted names like "checkout.session" → "checkout_sessions".
   * For simple names, returns as-is (e.g. "customer" → "customer").
   */
  private normalizeSyncObjectName(stripeObjectName: string): StripeObject {
    return (StripeSync.STRIPE_OBJECT_TO_SYNC_OBJECT[stripeObjectName] ??
      stripeObjectName) as StripeObject
  }

  async upsertAny(
    items: { [Key: string]: any }[], // eslint-disable-line @typescript-eslint/no-explicit-any
    accountId: string,
    backfillRelatedEntities?: boolean,
    syncTimestamp?: string
  ): Promise<unknown[]> {
    if (items.length === 0) return []
    const stripeObjectName = items[0].object

    const syncObjectName = this.normalizeSyncObjectName(stripeObjectName)
    const dependencies = this.resourceRegistry[syncObjectName]?.dependencies ?? []
    if (backfillRelatedEntities ?? this.config.backfillRelatedEntities) {
      await Promise.all(
        dependencies.map((dependency) =>
          this.backfillAny(getUniqueIds(items, dependency), dependency as StripeObject, accountId)
        )
      )
    }

    const config = this.resourceRegistry[syncObjectName]
    if (config?.listExpands) {
      for (const expandEntry of config.listExpands) {
        for (const [property, expandFn] of Object.entries(expandEntry)) {
          await expandEntity(
            items,
            property,
            (id) => expandFn(id),
            this.config.autoExpandLists ?? false
          )
        }
      }
    }

    const tableName = getTableName(syncObjectName, this.resourceRegistry)
    const rows = this.postgresClient.upsertManyWithTimestampProtection(
      items,
      tableName,
      accountId,
      syncTimestamp
    )
    return rows
  }

  async backfillAny(ids: string[], objectName: StripeObject, accountId: string) {
    const config = this.resourceRegistry[objectName]
    const tableName = config?.tableName ?? objectName
    if (!config?.retrieveFn) {
      throw new Error(`No retrieveFn registered for resource: ${objectName}`)
    }

    const missingIds = await this.postgresClient.findMissingEntries(tableName, ids)

    const items = await this.fetchMissingEntities(missingIds, (id) => config.retrieveFn!(id))
    return this.upsertAny(items, accountId)
  }

  async upsertSubscriptionItems(
    subscriptionItems: Stripe.SubscriptionItem[],
    accountId: string,
    syncTimestamp?: string
  ) {
    const modifiedSubscriptionItems = subscriptionItems.map((subscriptionItem) => {
      // Modify price object to string id; reference prices table
      const priceId = subscriptionItem.price.id.toString()
      // deleted exists only on a deleted item
      const deleted = subscriptionItem.deleted
      // quantity not exist on volume tier item
      const quantity = subscriptionItem.quantity
      return {
        ...subscriptionItem,
        price: priceId,
        deleted: deleted ?? false,
        quantity: quantity ?? null,
      }
    })

    await this.postgresClient.upsertManyWithTimestampProtection(
      modifiedSubscriptionItems,
      'subscription_items',
      accountId,
      syncTimestamp
    )
  }

  async markDeletedSubscriptionItems(
    subscriptionId: string,
    currentSubItemIds: string[]
  ): Promise<{ rowCount: number }> {
    // deleted is a generated column that may be NULL for non-deleted items
    let prepared = sql(`
    select id from "stripe"."subscription_items"
    where subscription = :subscriptionId and COALESCE(deleted, false) = false;
    `)({ subscriptionId })
    const { rows } = await this.postgresClient.query(prepared.text, prepared.values)
    const deletedIds = rows.filter(
      ({ id }: { id: string }) => currentSubItemIds.includes(id) === false
    )

    if (deletedIds.length > 0) {
      const ids = deletedIds.map(({ id }: { id: string }) => id)
      // Since deleted is a generated column, we need to update raw_data instead
      // Use jsonb_set to set the deleted field to true in the raw_data JSON
      prepared = sql(`
      update "stripe"."subscription_items"
      set _raw_data = jsonb_set(_raw_data, '{deleted}', 'true'::jsonb)
      where id=any(:ids::text[]);
      `)({ ids })
      const { rowCount } = await this.postgresClient.query(prepared.text, prepared.values)
      return { rowCount: rowCount || 0 }
    } else {
      return { rowCount: 0 }
    }
  }

  async upsertSubscriptions(
    subscriptions: Stripe.Subscription[],
    accountId: string,
    backfillRelatedEntities?: boolean,
    syncTimestamp?: string
  ): Promise<void> {
    await this.upsertAny(subscriptions, accountId, backfillRelatedEntities, syncTimestamp)

    // Upsert subscription items into a separate table
    // need to run after upsert subscription cos subscriptionItems will reference the subscription
    const allSubscriptionItems = subscriptions.flatMap((subscription) => subscription.items.data)
    await this.upsertSubscriptionItems(allSubscriptionItems, accountId, syncTimestamp)

    // We have to mark existing subscription item in db as deleted
    // if it doesn't exist in current subscriptionItems list
    const markSubscriptionItemsDeleted: Promise<{ rowCount: number }>[] = []
    for (const subscription of subscriptions) {
      const subscriptionItems = subscription.items.data
      const subItemIds = subscriptionItems.map((x: Stripe.SubscriptionItem) => x.id)
      markSubscriptionItemsDeleted.push(
        this.markDeletedSubscriptionItems(subscription.id, subItemIds)
      )
    }
    await Promise.all(markSubscriptionItemsDeleted)
  }

  async upsertActiveEntitlements(
    customerId: string,
    activeEntitlements: Stripe.Entitlements.ActiveEntitlement[],
    accountId: string,
    backfillRelatedEntities?: boolean,
    syncTimestamp?: string
  ) {
    const entitlements = activeEntitlements.map((entitlement) => ({
      id: entitlement.id,
      object: entitlement.object,
      feature:
        typeof entitlement.feature === 'string' ? entitlement.feature : entitlement.feature.id,
      customer: customerId,
      livemode: entitlement.livemode,
      lookup_key: entitlement.lookup_key,
    }))

    return this.upsertAny(entitlements, accountId, backfillRelatedEntities, syncTimestamp)
  }

  async fetchMissingEntities<T>(
    ids: string[],
    fetch: (id: string) => Promise<Stripe.Response<T>>
  ): Promise<T[]> {
    if (!ids.length) return []

    const entities: T[] = []

    for (const id of ids) {
      const entity = await fetch(id)
      entities.push(entity)
    }

    return entities
  }

  /**
   * Closes the database connection pool and cleans up resources.
   * Call this when you're done using the StripeSync instance.
   */
  async close(): Promise<void> {
    await this.postgresClient.pool.end()
  }
}
