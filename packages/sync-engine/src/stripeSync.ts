import Stripe from 'stripe'
import { pg as sql } from 'yesql'
import pkg from '../package.json' with { type: 'json' }
import { PostgresClient } from './database/postgres'
import { StripeSyncConfig, Sync, SyncObject, type ResourceConfig } from './types'
import { type PoolConfig } from 'pg'
import { hashApiKey } from './utils/hashApiKey'
import { expandEntity } from './utils/expandEntity'
import { SigmaSyncProcessor } from './sigma/sigmaSyncProcessor'
import { StripeSyncWebhook } from './stripeSyncWebhook'
import {
  buildResourceRegistry,
  getResourceConfigFromId,
  getTableName,
  normalizeStripeObjectName,
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

function buildPoolConfig(config: StripeSyncConfig): PoolConfig {
  const poolConfig = config.poolConfig ?? ({} as PoolConfig)
  if (config.databaseUrl) poolConfig.connectionString = config.databaseUrl
  if (config.maxPostgresConnections) poolConfig.max = config.maxPostgresConnections
  poolConfig.max ??= 10
  poolConfig.keepAlive ??= true
  return poolConfig
}

function getUniqueIds<T>(entries: T[], key: keyof T & string): string[] {
  const set = new Set(
    entries.map((entry) => entry?.[key]?.toString()).filter((it): it is string => Boolean(it))
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

    const poolConfig = buildPoolConfig(config)

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
      sigma: this.sigma,
    })
  }

  /**
   * Create a new StripeSync instance. Resolves the default Stripe account,
   * stores it in the database, and makes the account ID available immediately.
   */
  static async create(config: StripeSyncConfig): Promise<StripeSync> {
    const instance = new StripeSync(config)
    if (config.stripeAccountId) {
      instance.accountId = config.stripeAccountId
    } else {
      const account = await instance.getCurrentAccount()
      instance.accountId = account.id
    }
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
    return account.id
  }

  /**
   * Get the current account being synced. Uses database lookup by API key hash,
   * with fallback to Stripe API if not found (first-time setup or new API key).
   * @param objectAccountId - Optional account ID from event data (Connect scenarios)
   */
  async getCurrentAccount(objectAccountId?: string): Promise<Stripe.Account> {
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
      const message =
        error instanceof Error ? error.message : typeof error === 'string' ? error : String(error)
      throw new Error(`Failed to retrieve Stripe account: ${message}`)
    }
  }

  /**
   * Ordered for backfill: parents before children (products before prices, customers before subscriptions).
   * Order is determined by the `order` field in resourceRegistry.
   */
  public getSupportedSyncObjects(): Exclude<SyncObject, 'all' | 'customer_with_entitlements'>[] {
    const all = Object.entries(this.resourceRegistry)
      .filter(([, cfg]) => cfg.sync !== false)
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
    await this.upsertAny([item], accountId, false)
  }

  async fullSync(tables?: StripeObject[]): Promise<{
    results: Record<string, Sync>
    totals: Record<string, number>
    totalSynced: number
    skipped: string[]
    errors: Array<{ object: string; message: string }>
  }> {
    const objects = tables && tables.length > 0 ? tables : this.getSupportedSyncObjects()
    const tableNames = objects.map((obj) => getTableName(obj, this.resourceRegistry))
    const runKey = await this.postgresClient.joinOrCreateSyncRun(
      this.accountId,
      'fullSync',
      tableNames
    )

    // Reset any orphaned 'running' objects back to 'pending' (crash recovery).
    // If the previous process was killed mid-sync, object runs may be stuck in
    // 'running' with no active worker. Resetting lets new workers re-claim them.
    const resetCount = await this.postgresClient.resetStuckRunningObjects(
      runKey.accountId,
      runKey.runStartedAt
    )
    if (resetCount > 0) {
      this.config.logger?.info(
        { resetCount },
        `Reset ${resetCount} stuck 'running' object(s) to 'pending' (crash recovery)`
      )
    }

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
          runKey,
          this.upsertAny.bind(this)
        )
    )
    workers.forEach((worker) => worker.start())
    await Promise.all(workers.map((worker) => worker.waitUntilDone()))

    const totals = await this.postgresClient.getObjectSyncedCounts(
      this.accountId,
      runKey.runStartedAt
    )

    const results: Record<string, Sync> = {}
    const errors: Array<{ object: string; message: string }> = []
    for (const [obj, count] of Object.entries(totals)) {
      results[obj] = { synced: count }
    }
    const totalSynced = Object.values(totals).reduce((sum, count) => sum + count, 0)

    await this.postgresClient.closeSyncRun(runKey.accountId, runKey.runStartedAt)

    return { results, totals, totalSynced, skipped: [], errors }
  }

  async upsertAny(
    items: { [Key: string]: any }[], // eslint-disable-line @typescript-eslint/no-explicit-any
    accountId: string,
    backfillRelatedEntities?: boolean,
    syncTimestamp?: string
  ): Promise<unknown[]> {
    if (items.length === 0) return []
    const stripeObjectName = items[0].object

    const syncObjectName = normalizeStripeObjectName(stripeObjectName)
    const dependencies = this.resourceRegistry[syncObjectName]?.dependencies ?? []
    if (backfillRelatedEntities ?? this.config.backfillRelatedEntities) {
      await Promise.all(
        dependencies.map((dependency) =>
          this.backfillAny(
            getUniqueIds(items, dependency),
            dependency as StripeObject,
            accountId,
            syncTimestamp
          )
        )
      )
    }

    const config = this.resourceRegistry[syncObjectName]
    const autoExpandLists = this.config.autoExpandLists ?? false
    if (autoExpandLists && config?.listExpands) {
      for (const expandEntry of config.listExpands) {
        for (const [property, expandFn] of Object.entries(expandEntry)) {
          await expandEntity(items, property, (id) => expandFn(id))
        }
      }
    }

    const tableName = getTableName(syncObjectName, this.resourceRegistry)
    const rows = await this.postgresClient.upsertManyWithTimestampProtection(
      items,
      tableName,
      accountId,
      syncTimestamp
    )

    if (syncObjectName === 'subscription') {
      await this.syncSubscriptionItems(items as Stripe.Subscription[], accountId, syncTimestamp)
    }

    return rows
  }

  async backfillAny(
    ids: string[],
    objectName: StripeObject,
    accountId: string,
    syncTimestamp?: string
  ) {
    const config = this.resourceRegistry[objectName]
    const tableName = config?.tableName ?? objectName
    if (!config?.retrieveFn) {
      throw new Error(`No retrieveFn registered for resource: ${objectName}`)
    }

    const missingIds = await this.postgresClient.findMissingEntries(tableName, ids)

    const items = await this.fetchMissingEntities(missingIds, (id) => config.retrieveFn!(id))
    return this.upsertAny(items, accountId, false, syncTimestamp)
  }

  /**
   * Upsert subscription items into a separate table and mark removed items as deleted.
   * Skips deleted subscriptions that have no items data.
   */
  private async syncSubscriptionItems(
    subscriptions: Stripe.Subscription[],
    accountId: string,
    syncTimestamp?: string
  ) {
    const subscriptionsWithItems = subscriptions.filter((s) => s.items?.data)

    const allSubscriptionItems = subscriptionsWithItems.flatMap((s) => s.items.data)
    await this.upsertSubscriptionItems(allSubscriptionItems, accountId, syncTimestamp)

    // Mark existing subscription items in db as deleted
    // if they don't exist in the current subscriptionItems list
    await Promise.all(
      subscriptionsWithItems.map((subscription) => {
        const subItemIds = subscription.items.data.map((x: Stripe.SubscriptionItem) => x.id)
        return this.markDeletedSubscriptionItems(subscription.id, subItemIds)
      })
    )
  }

  async upsertSubscriptionItems(
    subscriptionItems: Stripe.SubscriptionItem[],
    accountId: string,
    syncTimestamp?: string
  ) {
    const modifiedSubscriptionItems = subscriptionItems.map((subscriptionItem) => ({
      ...subscriptionItem,
      price: subscriptionItem.price.id.toString(),
      deleted: subscriptionItem.deleted ?? false,
      quantity: subscriptionItem.quantity ?? null,
    }))

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
    return Promise.all(ids.map(fetch))
  }

  /**
   * Closes the database connection pool and cleans up resources.
   * Call this when you're done using the StripeSync instance.
   */
  async close(): Promise<void> {
    await this.postgresClient.pool.end()
  }
}
