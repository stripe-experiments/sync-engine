import Stripe from 'stripe'
import { pg as sql } from 'yesql'
import pkg from '../package.json' with { type: 'json' }
import { PostgresClient } from './database/postgres'
import {
  StripeSyncConfig,
  Sync,
  SyncBackfill,
  SyncParams,
  ProcessNextResult,
  ProcessNextParams,
  SyncObject,
  type ResourceConfig,
  BACKFILL_DEPENDENCY_MAP,
} from './types'
import { type PoolConfig } from 'pg'
import { hashApiKey } from './utils/hashApiKey'
import { expandEntity } from './utils/expandEntity'
import { SigmaSyncProcessor } from './sigma/sigmaSyncProcessor'
import { StripeSyncWebhook } from './stripeSyncWebhook'

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
  readonly resourceRegistry: Record<string, ResourceConfig>
  readonly webhook: StripeSyncWebhook
  readonly sigma: SigmaSyncProcessor
  private readonly defaultAccountIdPromise: Promise<string>

  get sigmaSchemaName(): string {
    return this.sigma.sigmaSchemaName
  }

  constructor(config: StripeSyncConfig) {
    this.config = config
    // Create base Stripe client
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

    this.resourceRegistry = this.buildResourceRegistry()
    this.defaultAccountIdPromise = this.resolveDefaultAccountId()
    this.webhook = new StripeSyncWebhook({
      stripe: this.stripe,
      postgresClient: this.postgresClient,
      config: this.config,
      accountIdPromise: this.defaultAccountIdPromise,
      getCurrentAccount: this.getCurrentAccount.bind(this),
      upsertAny: this.upsertAny.bind(this),
    })
  }

  // Resource registry - maps SyncObject → list/upsert operations for processNext()
  // Complements eventHandlers which maps event types → handlers for webhooks
  // Both registries share the same underlying upsert methods
  // Order field determines backfill sequence - parents before children for FK dependencies
  buildResourceRegistry(): Record<string, ResourceConfig> {
    const core: Record<string, ResourceConfig> = {
      product: {
        order: 1, // No dependencies
        listFn: (p) => this.stripe.products.list(p),
        retrieveFn: (id) => this.stripe.products.retrieve(id),
        upsertFn: (items, id) => this.upsertAny(items as Stripe.Product[], id),
        supportsCreatedFilter: true,
      },
      price: {
        order: 2, // Depends on product
        listFn: (p) => this.stripe.prices.list(p),
        retrieveFn: (id) => this.stripe.prices.retrieve(id),
        upsertFn: (items, id, bf) => this.upsertAny(items as Stripe.Price[], id, bf),
        supportsCreatedFilter: true,
      },
      plan: {
        order: 3, // Depends on product
        listFn: (p) => this.stripe.plans.list(p),
        retrieveFn: (id) => this.stripe.plans.retrieve(id),
        upsertFn: (items, id, bf) => this.upsertAny(items as Stripe.Plan[], id, bf),
        supportsCreatedFilter: true,
      },
      customer: {
        order: 4, // No dependencies
        listFn: (p) => this.stripe.customers.list(p),
        retrieveFn: (id) => this.stripe.customers.retrieve(id),
        upsertFn: (items, id) => this.upsertAny(items as Stripe.Customer[], id),
        supportsCreatedFilter: true,
      },
      subscription: {
        order: 5, // Depends on customer, price
        listFn: (p) => this.stripe.subscriptions.list(p),
        retrieveFn: (id) => this.stripe.subscriptions.retrieve(id),
        upsertFn: (items, id, bf) => this.upsertSubscriptions(items as Stripe.Subscription[], id, bf),
        listExpands: [
          { items: (id) => this.stripe.subscriptionItems.list({ subscription: id, limit: 100 }) },
        ],
        supportsCreatedFilter: true,
      },
      subscription_schedules: {
        order: 6, // Depends on customer
        listFn: (p) => this.stripe.subscriptionSchedules.list(p),
        retrieveFn: (id) => this.stripe.subscriptionSchedules.retrieve(id),
        upsertFn: (items, id, bf) =>this.upsertAny(items as Stripe.SubscriptionSchedule[], id, bf),
        supportsCreatedFilter: true,
      },
      invoice: {
        order: 7, // Depends on customer, subscription
        listFn: (p) => this.stripe.invoices.list(p),
        retrieveFn: (id) => this.stripe.invoices.retrieve(id),
        upsertFn: (items, id, bf) => this.upsertAny(items as Stripe.Invoice[], id, bf),
        listExpands: [{ lines: (id) => this.stripe.invoices.listLineItems(id, { limit: 100 }) }],
        supportsCreatedFilter: true,
      },
      charge: {
        order: 8, // Depends on customer, invoice
        listFn: (p) => this.stripe.charges.list(p),
        retrieveFn: (id) => this.stripe.charges.retrieve(id),
        upsertFn: (items, id, bf) => this.upsertAny(items as Stripe.Charge[], id, bf),
        listExpands: [{ refunds: (id) => this.stripe.refunds.list({ charge: id, limit: 100 }) }],
        supportsCreatedFilter: true,
      },
      setup_intent: {
        order: 9, // Depends on customer
        listFn: (p) => this.stripe.setupIntents.list(p),
        retrieveFn: (id) => this.stripe.setupIntents.retrieve(id),
        upsertFn: (items, id, bf) => this.upsertAny(items as Stripe.SetupIntent[], id, bf),
        supportsCreatedFilter: true,
      },
      payment_method: {
        order: 10, // Depends on customer (special: iterates customers)
        listFn: (p) => this.stripe.paymentMethods.list(p),
        retrieveFn: (id) => this.stripe.paymentMethods.retrieve(id),
        upsertFn: (items, id, bf) => this.upsertAny(items as Stripe.PaymentMethod[], id, bf),
        supportsCreatedFilter: false, // Requires customer param, can't filter by created
      },
      payment_intent: {
        order: 11, // Depends on customer
        listFn: (p) => this.stripe.paymentIntents.list(p),
        retrieveFn: (id) => this.stripe.paymentIntents.retrieve(id),
        upsertFn: (items, id, bf) => this.upsertAny(items as Stripe.PaymentIntent[], id, bf),
        supportsCreatedFilter: true,
      },
      tax_id: {
        order: 12, // Depends on customer
        listFn: (p) => this.stripe.taxIds.list(p),
        retrieveFn: (id) => this.stripe.taxIds.retrieve(id),
        upsertFn: (items, id, bf) => this.upsertAny(items as Stripe.TaxId[], id, bf),
        supportsCreatedFilter: false, // taxIds don't support created filter
      },
      credit_note: {
        order: 13, // Depends on invoice
        listFn: (p) => this.stripe.creditNotes.list(p),
        retrieveFn: (id) => this.stripe.creditNotes.retrieve(id),
        upsertFn: (items, id, bf) => this.upsertAny(items as Stripe.CreditNote[], id, bf),
        listExpands: [
          { listLineItems: (id) => this.stripe.creditNotes.listLineItems(id, { limit: 100 }) },
        ],
        supportsCreatedFilter: true, // credit_notes support created filter
      },
      dispute: {
        order: 14, // Depends on charge
        listFn: (p) => this.stripe.disputes.list(p),
        retrieveFn: (id) => this.stripe.disputes.retrieve(id),
        upsertFn: (items, id, bf) => this.upsertAny(items as Stripe.Dispute[], id, bf),
        supportsCreatedFilter: true,
      },
      early_fraud_warning: {
        order: 15, // Depends on charge
        listFn: (p) => this.stripe.radar.earlyFraudWarnings.list(p),
        retrieveFn: (id) => this.stripe.radar.earlyFraudWarnings.retrieve(id),
        upsertFn: (items, id) => this.upsertAny(items as Stripe.Radar.EarlyFraudWarning[], id),
        supportsCreatedFilter: true,
      },
      refund: {
        order: 16, // Depends on charge
        listFn: (p) => this.stripe.refunds.list(p),
        retrieveFn: (id) => this.stripe.refunds.retrieve(id),
        upsertFn: (items, id, bf) => this.upsertAny(items as Stripe.Refund[], id, bf),
        supportsCreatedFilter: true,
      },
      checkout_sessions: {
        order: 17, // Depends on customer (optional)
        listFn: (p) => this.stripe.checkout.sessions.list(p),
        retrieveFn: (id) => this.stripe.checkout.sessions.retrieve(id),
        upsertFn: (items, id, bf) => this.upsertAny(items as Stripe.Checkout.Session[], id, bf),
        supportsCreatedFilter: true,
        listExpands: [
          { lines: (id) => this.stripe.checkout.sessions.listLineItems(id, { limit: 100 }) },
        ],
      },
    }

    const maxOrder = Math.max(...Object.values(core).map((cfg) => cfg.order))
    const sigmaEntries = this.sigma.buildSigmaRegistryEntries(maxOrder)

    // Core configs take precedence over sigma to preserve supportsCreatedFilter and other settings
    return { ...sigmaEntries, ...core }
  }

  isSigmaResource(object: string): boolean {
    return this.sigma.isSigmaResource(this.resourceRegistry, object)
  }

  sigmaResultKey(tableName: string): string {
    return this.sigma.sigmaResultKey(tableName)
  }

  /**
   * Get the Stripe account ID. Delegates to getCurrentAccount() for the actual lookup.
   */
  async getAccountId(objectAccountId?: string): Promise<string> {
    if (!objectAccountId) {
      return this.defaultAccountIdPromise
    }

    const account = await this.getCurrentAccount(objectAccountId)
    if (!account) {
      throw new Error('Failed to retrieve Stripe account. Please ensure API key is valid.')
    }
    return account.id
  }

  private async resolveDefaultAccountId(): Promise<string> {
    const account = await this.getCurrentAccount()
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
   * Get all accounts that have been synced to the database
   */
  async getAllSyncedAccounts(): Promise<Stripe.Account[]> {
    try {
      const accountsData = await this.postgresClient.getAllAccounts()
      return accountsData as Stripe.Account[]
    } catch (error) {
      this.config.logger?.error(error, 'Failed to retrieve accounts from database')
      throw new Error('Failed to retrieve synced accounts from database')
    }
  }

  /**
   * DANGEROUS: Delete an account and all associated data from the database
   * This operation cannot be undone!
   *
   * @param accountId - The Stripe account ID to delete
   * @param options - Options for deletion behavior
   * @param options.dryRun - If true, only count records without deleting (default: false)
   * @param options.useTransaction - If true, use transaction for atomic deletion (default: true)
   * @returns Deletion summary with counts and warnings
   */
  async dangerouslyDeleteSyncedAccountData(
    accountId: string,
    options?: {
      dryRun?: boolean
      useTransaction?: boolean
    }
  ): Promise<{
    deletedAccountId: string
    deletedRecordCounts: { [tableName: string]: number }
    warnings: string[]
  }> {
    const dryRun = options?.dryRun ?? false
    const useTransaction = options?.useTransaction ?? true

    this.config.logger?.info(
      `${dryRun ? 'Preview' : 'Deleting'} account ${accountId} (transaction: ${useTransaction})`
    )

    try {
      // Get record counts
      const counts = await this.postgresClient.getAccountRecordCounts(accountId)

      // Generate warnings
      const warnings: string[] = []
      let totalRecords = 0

      for (const [table, count] of Object.entries(counts)) {
        if (count > 0) {
          totalRecords += count
          warnings.push(`Will delete ${count} ${table} record${count !== 1 ? 's' : ''}`)
        }
      }

      if (totalRecords > 100000) {
        warnings.push(
          `Large dataset detected (${totalRecords} total records). Consider using useTransaction: false for better performance.`
        )
      }

      // Dry-run mode: just return counts
      if (dryRun) {
        this.config.logger?.info(`Dry-run complete: ${totalRecords} total records would be deleted`)
        return {
          deletedAccountId: accountId,
          deletedRecordCounts: counts,
          warnings,
        }
      }

      // Actual deletion
      const deletionCounts = await this.postgresClient.deleteAccountWithCascade(
        accountId,
        useTransaction
      )

      this.config.logger?.info(
        `Successfully deleted account ${accountId} with ${totalRecords} total records`
      )

      return {
        deletedAccountId: accountId,
        deletedRecordCounts: deletionCounts,
        warnings,
      }
    } catch (error) {
      this.config.logger?.error(error, `Failed to delete account ${accountId}`)
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      throw new Error(`Failed to delete account ${accountId}: ${errorMessage}`)
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
      return all.filter((o) => !this.isSigmaResource(o)) as Exclude<
        SyncObject,
        'all' | 'customer_with_entitlements'
      >[]
    }

    return all
  }

  /**
   * Get the list of Sigma-backed object types that can be synced.
   * Only returns sigma objects when enableSigma is true.
   *
   * @returns Array of sigma object names (e.g. 'subscription_item_change_events_v2_beta')
   */
  public getSupportedSigmaObjects(): string[] {
    return this.sigma.getSupportedSigmaObjects(this.resourceRegistry)
  }

  async syncSingleEntity(stripeId: string) {
    const accountId = await this.getAccountId()
    if (stripeId.startsWith('cus_')) {
      return this.stripe.customers.retrieve(stripeId).then((it) => {
        if (!it || it.deleted) return
        return this.upsertAny([it], accountId)
      })
    } else if (stripeId.startsWith('in_')) {
      return this.stripe.invoices.retrieve(stripeId).then((it) => this.upsertAny([it], accountId))
    } else if (stripeId.startsWith('price_')) {
      return this.stripe.prices.retrieve(stripeId).then((it) => this.upsertAny([it], accountId))
    } else if (stripeId.startsWith('prod_')) {
      return this.stripe.products.retrieve(stripeId).then((it) => this.upsertAny([it], accountId))
    } else if (stripeId.startsWith('sub_')) {
      return this.stripe.subscriptions
        .retrieve(stripeId)
        .then((it) => this.upsertAny([it], accountId))
    } else if (stripeId.startsWith('seti_')) {
      return this.stripe.setupIntents
        .retrieve(stripeId)
        .then((it) => this.upsertAny([it], accountId))
    } else if (stripeId.startsWith('pm_')) {
      return this.stripe.paymentMethods
        .retrieve(stripeId)
        .then((it) => this.upsertAny([it], accountId))
    } else if (stripeId.startsWith('dp_') || stripeId.startsWith('du_')) {
      return this.stripe.disputes.retrieve(stripeId).then((it) => this.upsertAny([it], accountId))
    } else if (stripeId.startsWith('ch_')) {
      return this.stripe.charges
        .retrieve(stripeId)
        .then((it) => this.upsertAny([it], accountId, true))
    } else if (stripeId.startsWith('pi_')) {
      return this.stripe.paymentIntents
        .retrieve(stripeId)
        .then((it) => this.upsertAny([it], accountId))
    } else if (stripeId.startsWith('txi_')) {
      return this.stripe.taxIds.retrieve(stripeId).then((it) => this.upsertAny([it], accountId))
    } else if (stripeId.startsWith('cn_')) {
      return this.stripe.creditNotes
        .retrieve(stripeId)
        .then((it) => this.upsertAny([it], accountId))
    } else if (stripeId.startsWith('issfr_')) {
      return this.stripe.radar.earlyFraudWarnings
        .retrieve(stripeId)
        .then((it) => this.upsertAny([it], accountId))
    } else if (stripeId.startsWith('prv_')) {
      return this.stripe.reviews.retrieve(stripeId).then((it) => this.upsertAny([it], accountId))
    } else if (stripeId.startsWith('re_')) {
      return this.stripe.refunds.retrieve(stripeId).then((it) => this.upsertAny([it], accountId))
    } else if (stripeId.startsWith('feat_')) {
      return this.stripe.entitlements.features
        .retrieve(stripeId)
        .then((it) => this.upsertAny([it], accountId))
    } else if (stripeId.startsWith('cs_')) {
      return this.stripe.checkout.sessions
        .retrieve(stripeId)
        .then((it) => this.upsertAny([it], accountId))
    }
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
      // Ensure account exists before syncing
      await this.getCurrentAccount()
      const accountId = await this.getAccountId()

      // Map object type to resource name (database table)
      const resourceName = this.getResourceName(object)

      // Get or create sync run
      let runStartedAt: Date
      if (params?.runStartedAt) {
        runStartedAt = params.runStartedAt
      } else {
        const { runKey } = await this.joinOrCreateSyncRun(params?.triggeredBy ?? 'processNext')
        runStartedAt = runKey.runStartedAt
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
      throw this.appendMigrationHint(error)
    }
  }

  appendMigrationHint(error: unknown): Error {
    const hint =
      'Error occurred. Make sure you are up to date with DB migrations which can sometimes help with this. Details:'
    const withHint = (message: string) => (message.includes(hint) ? message : `${hint}\n${message}`)

    if (error instanceof Error) {
      const { stack } = error
      error.message = withHint(error.message)
      if (stack) error.stack = stack
      return error
    }

    return new Error(withHint(String(error)))
  }

  /**
   * Get the database resource name for a SyncObject type
   */
  getResourceName(object: SyncObject): string {
    const mapping: Record<string, string> = {
      customer: 'customers',
      invoice: 'invoices',
      price: 'prices',
      product: 'products',
      subscription: 'subscriptions',
      subscription_schedules: 'subscription_schedules',
      setup_intent: 'setup_intents',
      payment_method: 'payment_methods',
      dispute: 'disputes',
      charge: 'charges',
      payment_intent: 'payment_intents',
      plan: 'plans',
      tax_id: 'tax_ids',
      credit_note: 'credit_notes',
      early_fraud_warning: 'early_fraud_warnings',
      refund: 'refunds',
      checkout_sessions: 'checkout_sessions',
    }
    return mapping[object] || object
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

  /**
   * Process all pages for a single object type until complete.
   * Loops processNext() internally until hasMore is false.
   *
   * @param object - The object type to sync
   * @param runStartedAt - The sync run to use (for sharing across objects)
   * @param params - Optional sync parameters
   * @returns Sync result with count of synced items
   */
  async processObjectUntilDone(
    object: Exclude<SyncObject, 'all' | 'customer_with_entitlements'>,
    runStartedAt: Date,
    params?: SyncParams
  ): Promise<Sync> {
    let totalSynced = 0

    while (true) {
      const result = await this.processNext(object, {
        ...params,
        runStartedAt,
        triggeredBy: 'processUntilDone',
      })
      totalSynced += result.processed

      if (!result.hasMore) {
        break
      }
    }

    return { synced: totalSynced }
  }

  /**
   * Join existing sync run or create a new one.
   * Returns sync run key and list of supported objects to sync.
   *
   * Cooperative behavior: If a sync run already exists, joins it instead of failing.
   * This is used by workers and background processes that should cooperate.
   *
   * @param triggeredBy - What triggered this sync (for observability)
   * @param objectFilter - Optional specific object to sync (e.g. 'payment_intent'). If 'all' or undefined, syncs all objects.
   * @returns Run key and list of objects to sync
   */
  async joinOrCreateSyncRun(
    triggeredBy: string = 'worker',
    objectFilter?: SyncObject
  ): Promise<{
    runKey: RunKey
    objects: Exclude<SyncObject, 'all' | 'customer_with_entitlements'>[]
  }> {
    await this.getCurrentAccount()
    const accountId = await this.getAccountId()

    const result = await this.postgresClient.getOrCreateSyncRun(accountId, triggeredBy)

    // Determine which objects to create runs for
    const objects =
      objectFilter === 'all' || objectFilter === undefined
        ? this.getSupportedSyncObjects()
        : [objectFilter as Exclude<SyncObject, 'all' | 'customer_with_entitlements'>]

    if (!result) {
      const activeRun = await this.postgresClient.getActiveSyncRun(accountId)
      if (!activeRun) {
        throw new Error('Failed to get or create sync run')
      }
      // Create object runs upfront to prevent premature close
      // Convert object types to resource names for database storage
      await this.postgresClient.createObjectRuns(
        activeRun.accountId,
        activeRun.runStartedAt,
        objects.map((obj) => this.getResourceName(obj))
      )
      return {
        runKey: { accountId: activeRun.accountId, runStartedAt: activeRun.runStartedAt },
        objects,
      }
    }

    const { accountId: runAccountId, runStartedAt } = result
    // Create object runs upfront to prevent premature close
    // Convert object types to resource names for database storage
    await this.postgresClient.createObjectRuns(
      runAccountId,
      runStartedAt,
      objects.map((obj) => this.getResourceName(obj))
    )
    return {
      runKey: { accountId: runAccountId, runStartedAt },
      objects,
    }
  }

  applySyncBackfillResult(
    results: SyncBackfill,
    object: Exclude<SyncObject, 'all' | 'customer_with_entitlements'>,
    result: Sync
  ): void {
    if (this.isSigmaResource(object)) {
      results.sigma = results.sigma ?? {}
      results.sigma[object] = result
      const camelKey = this.sigmaResultKey(object)
      ;(results as Record<string, Sync>)[camelKey] = result
      return
    }

    // TODO: obj === 'payment_methods' reqiores special handling

    switch (object) {
      case 'product':
        results.products = result
        break
      case 'price':
        results.prices = result
        break
      case 'plan':
        results.plans = result
        break
      case 'customer':
        results.customers = result
        break
      case 'subscription':
        results.subscriptions = result
        break
      case 'subscription_schedules':
        results.subscriptionSchedules = result
        break
      case 'invoice':
        results.invoices = result
        break
      case 'charge':
        results.charges = result
        break
      case 'setup_intent':
        results.setupIntents = result
        break
      case 'payment_intent':
        results.paymentIntents = result
        break
      case 'tax_id':
        results.taxIds = result
        break
      case 'credit_note':
        results.creditNotes = result
        break
      case 'dispute':
        results.disputes = result
        break
      case 'early_fraud_warning':
        results.earlyFraudWarnings = result
        break
      case 'refund':
        results.refunds = result
        break
      case 'checkout_sessions':
        results.checkoutSessions = result
        break
    }
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

    const { runKey, objects } = await this.joinOrCreateSyncRun(triggeredBy, object)
    const runConfig = await this.postgresClient.getSyncRun(runKey.accountId, runKey.runStartedAt)
    const maxConcurrent = runConfig?.maxConcurrent ?? 10
    const workerCount = Math.max(
      1,
      Math.min(objects.length, maxParallel ?? maxConcurrent, maxConcurrent)
    )

    const totals: Record<string, number> = {}
    for (const obj of objects) {
      totals[obj] = 0
    }

    const skipped: string[] = []
    const errors: Array<{ object: string; message: string }> = []
    const queue = [...objects]
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
      for (const obj of objects) {
        this.applySyncBackfillResult(results, obj, { synced: totals[obj] ?? 0 })
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
    const { object } = params ?? { object: 'all' }

    // Join or create sync run with object filter
    const { runKey } = await this.joinOrCreateSyncRun('processUntilDone', object)

    return this.processUntilDoneWithRun(runKey.runStartedAt, object, params)
  }

  /**
   * Internal implementation of processUntilDone with an existing run.
   */
  async processUntilDoneWithRun(
    runStartedAt: Date,
    object: SyncObject | undefined,
    params?: SyncParams
  ): Promise<SyncBackfill> {
    const accountId = await this.getAccountId()

    const results: SyncBackfill = {}

    try {
      // Determine which objects to sync
      // getSupportedSyncObjects() returns objects in correct dependency order for backfills
      const objectsToSync: Exclude<SyncObject, 'all' | 'customer_with_entitlements'>[] =
        object === 'all' || object === undefined
          ? this.getSupportedSyncObjects()
          : [object as Exclude<SyncObject, 'all' | 'customer_with_entitlements'>]

      // Sync each object type
      for (const obj of objectsToSync) {
        this.config.logger?.info(`Syncing ${obj}`)
        const result = await this.processObjectUntilDone(obj, runStartedAt, params)
        this.applySyncBackfillResult(results, obj, result)
      }

      // Close the sync run after all objects are done (status derived from object states)
      await this.postgresClient.closeSyncRun(accountId, runStartedAt)

      return results
    } catch (error) {
      // Close the sync run on error (status will be 'error' based on failed object states)
      await this.postgresClient.closeSyncRun(accountId, runStartedAt)
      throw error
    }
  }
  /**
   * Maps Stripe API object type strings (e.g. "checkout.session") to SyncObject keys
   * used in BACKFILL_DEPENDENCY_MAP and getResourceName().
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
  private normalizeSyncObjectName(stripeObjectName: string): string {
    return StripeSync.STRIPE_OBJECT_TO_SYNC_OBJECT[stripeObjectName] ?? stripeObjectName
  }

  getTableName(objectName: string): string {
    let tableName = objectName.endsWith('s') ? objectName : `${objectName}s`
    return tableName.replace(/\./g, '_')
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
    const dependencies = BACKFILL_DEPENDENCY_MAP[syncObjectName] ?? []
    if (backfillRelatedEntities ?? this.config.backfillRelatedEntities) {
      await Promise.all(
        dependencies.map((dependency) =>
          this.backfillAny(getUniqueIds(items, dependency), dependency as SyncObject, accountId)
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

    const tableName = this.getTableName(stripeObjectName)
    console.log('tableName', tableName)
    const rows = this.postgresClient.upsertManyWithTimestampProtection(
      items,
      tableName,
      accountId,
      syncTimestamp
    )
    console.log('upsertAny items', items)
    return rows
  }

  async backfillAny(ids: string[], objectName: SyncObject, accountId: string) {
    console.log('backfillAny ids', ids)
    console.log('objectName', objectName)
    const tableName = this.getTableName(objectName)
    const config = this.resourceRegistry[objectName]
    if (!config?.retrieveFn) {
      throw new Error(`No retrieveFn registered for resource: ${objectName}`)
    }

    const missingIds = await this.postgresClient.findMissingEntries(tableName, ids)

    const items = await this.fetchMissingEntities(missingIds, (id) => config.retrieveFn!(id))
    console.log('backfillAny items', items)
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
