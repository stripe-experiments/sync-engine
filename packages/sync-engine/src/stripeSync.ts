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

  async fullResyncAll(
    tables?: Exclude<SyncObject, 'all' | 'customer_with_entitlements'>[]
  ): Promise<{
    results: SyncBackfill
    totals: Record<string, number>
    totalSynced: number
    skipped: string[]
    errors: Array<{ object: string; message: string }>
  }> {
    const objects = tables && tables.length > 0 ? tables : this.getSupportedSyncObjects()
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
