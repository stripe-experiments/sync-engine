import Stripe from 'stripe'
import pkg from '../package.json' with { type: 'json' }
import { managedWebhookSchema } from './schemas/managed_webhook'
import { type RevalidateEntity, type StripeSyncConfig } from './types'
import { PostgresClient } from './database/postgres'

export type StripeSyncWebhookDeps = {
  stripe: Stripe
  postgresClient: PostgresClient
  config: StripeSyncConfig
  accountIdPromise: Promise<string>
  getCurrentAccount: (objectAccountId?: string) => Promise<Stripe.Account | null>
  upsertAny: (
    items: any[],
    accountId: string,
    backfillRelatedEntities?: boolean,
    syncTimestamp?: string
  ) => Promise<unknown[]>
}

export class StripeSyncWebhook {
  // Note: Uses 'any' for event parameter to allow handlers with specific Stripe event types.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly eventHandlers: Record<string, (event: any, accountId: string) => Promise<void>>

  constructor(private readonly deps: StripeSyncWebhookDeps) {
    this.eventHandlers = {
      'charge.captured': this.handleChargeEvent.bind(this),
      'charge.expired': this.handleChargeEvent.bind(this),
      'charge.failed': this.handleChargeEvent.bind(this),
      'charge.pending': this.handleChargeEvent.bind(this),
      'charge.refunded': this.handleChargeEvent.bind(this),
      'charge.succeeded': this.handleChargeEvent.bind(this),
      'charge.updated': this.handleChargeEvent.bind(this),
      'customer.deleted': this.handleCustomerDeletedEvent.bind(this),
      'customer.created': this.handleCustomerEvent.bind(this),
      'customer.updated': this.handleCustomerEvent.bind(this),
      'checkout.session.async_payment_failed': this.handleCheckoutSessionEvent.bind(this),
      'checkout.session.async_payment_succeeded': this.handleCheckoutSessionEvent.bind(this),
      'checkout.session.completed': this.handleCheckoutSessionEvent.bind(this),
      'checkout.session.expired': this.handleCheckoutSessionEvent.bind(this),
      'customer.subscription.created': this.handleSubscriptionEvent.bind(this),
      'customer.subscription.deleted': this.handleSubscriptionEvent.bind(this),
      'customer.subscription.paused': this.handleSubscriptionEvent.bind(this),
      'customer.subscription.pending_update_applied': this.handleSubscriptionEvent.bind(this),
      'customer.subscription.pending_update_expired': this.handleSubscriptionEvent.bind(this),
      'customer.subscription.trial_will_end': this.handleSubscriptionEvent.bind(this),
      'customer.subscription.resumed': this.handleSubscriptionEvent.bind(this),
      'customer.subscription.updated': this.handleSubscriptionEvent.bind(this),
      'customer.tax_id.updated': this.handleTaxIdEvent.bind(this),
      'customer.tax_id.created': this.handleTaxIdEvent.bind(this),
      'customer.tax_id.deleted': this.handleTaxIdDeletedEvent.bind(this),
      'invoice.created': this.handleInvoiceEvent.bind(this),
      'invoice.deleted': this.handleInvoiceEvent.bind(this),
      'invoice.finalized': this.handleInvoiceEvent.bind(this),
      'invoice.finalization_failed': this.handleInvoiceEvent.bind(this),
      'invoice.paid': this.handleInvoiceEvent.bind(this),
      'invoice.payment_action_required': this.handleInvoiceEvent.bind(this),
      'invoice.payment_failed': this.handleInvoiceEvent.bind(this),
      'invoice.payment_succeeded': this.handleInvoiceEvent.bind(this),
      'invoice.upcoming': this.handleInvoiceEvent.bind(this),
      'invoice.sent': this.handleInvoiceEvent.bind(this),
      'invoice.voided': this.handleInvoiceEvent.bind(this),
      'invoice.marked_uncollectible': this.handleInvoiceEvent.bind(this),
      'invoice.updated': this.handleInvoiceEvent.bind(this),
      'product.created': this.handleProductEvent.bind(this),
      'product.updated': this.handleProductEvent.bind(this),
      'product.deleted': this.handleProductDeletedEvent.bind(this),
      'price.created': this.handlePriceEvent.bind(this),
      'price.updated': this.handlePriceEvent.bind(this),
      'price.deleted': this.handlePriceDeletedEvent.bind(this),
      'plan.created': this.handlePlanEvent.bind(this),
      'plan.updated': this.handlePlanEvent.bind(this),
      'plan.deleted': this.handlePlanDeletedEvent.bind(this),
      'setup_intent.canceled': this.handleSetupIntentEvent.bind(this),
      'setup_intent.created': this.handleSetupIntentEvent.bind(this),
      'setup_intent.requires_action': this.handleSetupIntentEvent.bind(this),
      'setup_intent.setup_failed': this.handleSetupIntentEvent.bind(this),
      'setup_intent.succeeded': this.handleSetupIntentEvent.bind(this),
      'subscription_schedule.aborted': this.handleSubscriptionScheduleEvent.bind(this),
      'subscription_schedule.canceled': this.handleSubscriptionScheduleEvent.bind(this),
      'subscription_schedule.completed': this.handleSubscriptionScheduleEvent.bind(this),
      'subscription_schedule.created': this.handleSubscriptionScheduleEvent.bind(this),
      'subscription_schedule.expiring': this.handleSubscriptionScheduleEvent.bind(this),
      'subscription_schedule.released': this.handleSubscriptionScheduleEvent.bind(this),
      'subscription_schedule.updated': this.handleSubscriptionScheduleEvent.bind(this),
      'payment_method.attached': this.handlePaymentMethodEvent.bind(this),
      'payment_method.automatically_updated': this.handlePaymentMethodEvent.bind(this),
      'payment_method.detached': this.handlePaymentMethodEvent.bind(this),
      'payment_method.updated': this.handlePaymentMethodEvent.bind(this),
      'charge.dispute.created': this.handleDisputeEvent.bind(this),
      'charge.dispute.funds_reinstated': this.handleDisputeEvent.bind(this),
      'charge.dispute.funds_withdrawn': this.handleDisputeEvent.bind(this),
      'charge.dispute.updated': this.handleDisputeEvent.bind(this),
      'charge.dispute.closed': this.handleDisputeEvent.bind(this),
      'payment_intent.amount_capturable_updated': this.handlePaymentIntentEvent.bind(this),
      'payment_intent.canceled': this.handlePaymentIntentEvent.bind(this),
      'payment_intent.created': this.handlePaymentIntentEvent.bind(this),
      'payment_intent.partially_funded': this.handlePaymentIntentEvent.bind(this),
      'payment_intent.payment_failed': this.handlePaymentIntentEvent.bind(this),
      'payment_intent.processing': this.handlePaymentIntentEvent.bind(this),
      'payment_intent.requires_action': this.handlePaymentIntentEvent.bind(this),
      'payment_intent.succeeded': this.handlePaymentIntentEvent.bind(this),
      'credit_note.created': this.handleCreditNoteEvent.bind(this),
      'credit_note.updated': this.handleCreditNoteEvent.bind(this),
      'credit_note.voided': this.handleCreditNoteEvent.bind(this),
      'radar.early_fraud_warning.created': this.handleEarlyFraudWarningEvent.bind(this),
      'radar.early_fraud_warning.updated': this.handleEarlyFraudWarningEvent.bind(this),
      'refund.created': this.handleRefundEvent.bind(this),
      'refund.failed': this.handleRefundEvent.bind(this),
      'refund.updated': this.handleRefundEvent.bind(this),
      'charge.refund.updated': this.handleRefundEvent.bind(this),
      'review.closed': this.handleReviewEvent.bind(this),
      'review.opened': this.handleReviewEvent.bind(this),
      'entitlements.active_entitlement_summary.updated':
        this.handleEntitlementSummaryEvent.bind(this),
    }
  }

  async processWebhook(payload: Buffer | Uint8Array | string, signature: string | undefined) {
    let webhookSecret: string | undefined = this.deps.config.stripeWebhookSecret

    if (!webhookSecret) {
      const accountId = await this.deps.accountIdPromise
      const result = await this.deps.postgresClient.query(
        `SELECT secret FROM "stripe"."_managed_webhooks" WHERE account_id = $1 LIMIT 1`,
        [accountId]
      )

      if (result.rows.length > 0) {
        webhookSecret = result.rows[0].secret as string
      }
    }

    if (!webhookSecret) {
      throw new Error(
        'No webhook secret provided. Either create a managed webhook or configure stripeWebhookSecret.'
      )
    }

    if (!signature) {
      throw new Error('Missing stripe-signature header')
    }

    const normalizedPayload =
      payload instanceof Uint8Array && !Buffer.isBuffer(payload) ? Buffer.from(payload) : payload

    const event = await this.deps.stripe.webhooks.constructEventAsync(
      normalizedPayload,
      signature,
      webhookSecret
    )
    return this.processEvent(event)
  }

  async processEvent(event: Stripe.Event) {
    const objectAccountId =
      event.data?.object && typeof event.data.object === 'object' && 'account' in event.data.object
        ? (event.data.object as { account?: string }).account
        : undefined
    const accountId = objectAccountId ?? (await this.deps.accountIdPromise)

    await this.deps.getCurrentAccount()

    const handler = this.eventHandlers[event.type]
    if (handler) {
      const entityId =
        event.data?.object && typeof event.data.object === 'object' && 'id' in event.data.object
          ? (event.data.object as { id: string }).id
          : 'unknown'
      this.deps.config.logger?.info(`Received webhook ${event.id}: ${event.type} for ${entityId}`)

      await handler(event, accountId)
    } else {
      this.deps.config.logger?.warn(
        `Received unhandled webhook event: ${event.type} (${event.id}). Ignoring.`
      )
    }
  }

  public getSupportedEventTypes(): Stripe.WebhookEndpointCreateParams.EnabledEvent[] {
    return Object.keys(
      this.eventHandlers
    ).sort() as Stripe.WebhookEndpointCreateParams.EnabledEvent[]
  }

  async handleChargeEvent(event: Stripe.Event, accountId: string): Promise<void> {
    const { entity: charge, refetched } = await this.fetchOrUseWebhookData(
      event.data.object as Stripe.Charge,
      (id) => this.deps.stripe.charges.retrieve(id),
      (charge) => charge.status === 'failed' || charge.status === 'succeeded'
    )

    await this.deps.upsertAny([charge], accountId, false, this.getSyncTimestamp(event, refetched))
  }

  async handleCustomerDeletedEvent(
    event: Stripe.CustomerDeletedEvent,
    accountId: string
  ): Promise<void> {
    const customer: Stripe.DeletedCustomer = {
      id: event.data.object.id,
      object: 'customer',
      deleted: true,
    }

    await this.deps.upsertAny([customer], accountId, false, this.getSyncTimestamp(event, false))
  }

  async handleCustomerEvent(event: Stripe.Event, accountId: string): Promise<void> {
    const { entity: customer, refetched } = await this.fetchOrUseWebhookData(
      event.data.object as Stripe.Customer | Stripe.DeletedCustomer,
      (id) => this.deps.stripe.customers.retrieve(id),
      (customer) => customer.deleted === true
    )

    await this.deps.upsertAny([customer], accountId, false, this.getSyncTimestamp(event, refetched))
  }

  async handleCheckoutSessionEvent(event: Stripe.Event, accountId: string): Promise<void> {
    const { entity: checkoutSession, refetched } = await this.fetchOrUseWebhookData(
      event.data.object as Stripe.Checkout.Session,
      (id) => this.deps.stripe.checkout.sessions.retrieve(id)
    )

    await this.deps.upsertAny(
      [checkoutSession],
      accountId,
      false,
      this.getSyncTimestamp(event, refetched)
    )
  }

  async handleSubscriptionEvent(event: Stripe.Event, accountId: string): Promise<void> {
    const { entity: subscription, refetched } = await this.fetchOrUseWebhookData(
      event.data.object as Stripe.Subscription,
      (id) => this.deps.stripe.subscriptions.retrieve(id),
      (subscription) =>
        subscription.status === 'canceled' || subscription.status === 'incomplete_expired'
    )

    await this.deps.upsertAny(
      [subscription],
      accountId,
      false,
      this.getSyncTimestamp(event, refetched)
    )
  }

  async handleTaxIdEvent(event: Stripe.Event, accountId: string): Promise<void> {
    const { entity: taxId, refetched } = await this.fetchOrUseWebhookData(
      event.data.object as Stripe.TaxId,
      (id) => this.deps.stripe.taxIds.retrieve(id)
    )

    await this.deps.upsertAny([taxId], accountId, false, this.getSyncTimestamp(event, refetched))
  }

  async handleTaxIdDeletedEvent(event: Stripe.Event, _accountId: string): Promise<void> {
    const taxId = event.data.object as Stripe.TaxId

    await this.deps.postgresClient.deleteTaxId(taxId.id)
  }

  async handleInvoiceEvent(event: Stripe.Event, accountId: string): Promise<void> {
    const { entity: invoice, refetched } = await this.fetchOrUseWebhookData(
      event.data.object as Stripe.Invoice,
      (id) => this.deps.stripe.invoices.retrieve(id),
      (invoice) => invoice.status === 'void'
    )

    await this.deps.upsertAny([invoice], accountId, false, this.getSyncTimestamp(event, refetched))
  }

  async handleProductEvent(event: Stripe.Event, accountId: string): Promise<void> {
    try {
      const { entity: product, refetched } = await this.fetchOrUseWebhookData(
        event.data.object as Stripe.Product,
        (id) => this.deps.stripe.products.retrieve(id)
      )

      await this.deps.upsertAny(
        [product],
        accountId,
        false,
        this.getSyncTimestamp(event, refetched)
      )
    } catch (err) {
      if (err instanceof Stripe.errors.StripeAPIError && err.code === 'resource_missing') {
        const product = event.data.object as Stripe.Product
        await this.deps.postgresClient.deleteProduct(product.id)
      } else {
        throw err
      }
    }
  }

  async handleProductDeletedEvent(
    event: Stripe.ProductDeletedEvent,
    _accountId: string
  ): Promise<void> {
    const product = event.data.object
    await this.deps.postgresClient.deleteProduct(product.id)
  }

  async handlePriceEvent(event: Stripe.Event, accountId: string): Promise<void> {
    try {
      const { entity: price, refetched } = await this.fetchOrUseWebhookData(
        event.data.object as Stripe.Price,
        (id) => this.deps.stripe.prices.retrieve(id)
      )

      await this.deps.upsertAny([price], accountId, false, this.getSyncTimestamp(event, refetched))
    } catch (err) {
      if (err instanceof Stripe.errors.StripeAPIError && err.code === 'resource_missing') {
        const price = event.data.object as Stripe.Price
        await this.deps.postgresClient.deletePrice(price.id)
      } else {
        throw err
      }
    }
  }

  async handlePriceDeletedEvent(
    event: Stripe.PriceDeletedEvent,
    _accountId: string
  ): Promise<void> {
    const price = event.data.object
    await this.deps.postgresClient.deletePrice(price.id)
  }

  async handlePlanEvent(event: Stripe.Event, accountId: string): Promise<void> {
    try {
      const { entity: plan, refetched } = await this.fetchOrUseWebhookData(
        event.data.object as Stripe.Plan,
        (id) => this.deps.stripe.plans.retrieve(id)
      )

      await this.deps.upsertAny([plan], accountId, false, this.getSyncTimestamp(event, refetched))
    } catch (err) {
      if (err instanceof Stripe.errors.StripeAPIError && err.code === 'resource_missing') {
        const plan = event.data.object as Stripe.Plan
        await this.deps.postgresClient.deletePlan(plan.id)
      } else {
        throw err
      }
    }
  }

  async handlePlanDeletedEvent(event: Stripe.PlanDeletedEvent, _accountId: string): Promise<void> {
    const plan = event.data.object
    await this.deps.postgresClient.deletePlan(plan.id)
  }

  async handleSetupIntentEvent(event: Stripe.Event, accountId: string): Promise<void> {
    const { entity: setupIntent, refetched } = await this.fetchOrUseWebhookData(
      event.data.object as Stripe.SetupIntent,
      (id) => this.deps.stripe.setupIntents.retrieve(id),
      (setupIntent) => setupIntent.status === 'canceled' || setupIntent.status === 'succeeded'
    )

    await this.deps.upsertAny(
      [setupIntent],
      accountId,
      false,
      this.getSyncTimestamp(event, refetched)
    )
  }

  async handleSubscriptionScheduleEvent(event: Stripe.Event, accountId: string): Promise<void> {
    const { entity: subscriptionSchedule, refetched } = await this.fetchOrUseWebhookData(
      event.data.object as Stripe.SubscriptionSchedule,
      (id) => this.deps.stripe.subscriptionSchedules.retrieve(id),
      (schedule) => schedule.status === 'canceled' || schedule.status === 'completed'
    )

    await this.deps.upsertAny(
      [subscriptionSchedule],
      accountId,
      false,
      this.getSyncTimestamp(event, refetched)
    )
  }

  async handlePaymentMethodEvent(event: Stripe.Event, accountId: string): Promise<void> {
    const { entity: paymentMethod, refetched } = await this.fetchOrUseWebhookData(
      event.data.object as Stripe.PaymentMethod,
      (id) => this.deps.stripe.paymentMethods.retrieve(id)
    )

    await this.deps.upsertAny(
      [paymentMethod],
      accountId,
      false,
      this.getSyncTimestamp(event, refetched)
    )
  }

  async handleDisputeEvent(event: Stripe.Event, accountId: string): Promise<void> {
    const { entity: dispute, refetched } = await this.fetchOrUseWebhookData(
      event.data.object as Stripe.Dispute,
      (id) => this.deps.stripe.disputes.retrieve(id),
      (dispute) => dispute.status === 'won' || dispute.status === 'lost'
    )

    await this.deps.upsertAny([dispute], accountId, false, this.getSyncTimestamp(event, refetched))
  }

  async handlePaymentIntentEvent(event: Stripe.Event, accountId: string): Promise<void> {
    const { entity: paymentIntent, refetched } = await this.fetchOrUseWebhookData(
      event.data.object as Stripe.PaymentIntent,
      (id) => this.deps.stripe.paymentIntents.retrieve(id),
      (entity) => entity.status === 'canceled' || entity.status === 'succeeded'
    )

    await this.deps.upsertAny(
      [paymentIntent],
      accountId,
      false,
      this.getSyncTimestamp(event, refetched)
    )
  }

  async handleCreditNoteEvent(event: Stripe.Event, accountId: string): Promise<void> {
    const { entity: creditNote, refetched } = await this.fetchOrUseWebhookData(
      event.data.object as Stripe.CreditNote,
      (id) => this.deps.stripe.creditNotes.retrieve(id),
      (creditNote) => creditNote.status === 'void'
    )

    await this.deps.upsertAny(
      [creditNote],
      accountId,
      false,
      this.getSyncTimestamp(event, refetched)
    )
  }

  async handleEarlyFraudWarningEvent(event: Stripe.Event, accountId: string): Promise<void> {
    const { entity: earlyFraudWarning, refetched } = await this.fetchOrUseWebhookData(
      event.data.object as Stripe.Radar.EarlyFraudWarning,
      (id) => this.deps.stripe.radar.earlyFraudWarnings.retrieve(id)
    )

    await this.deps.upsertAny(
      [earlyFraudWarning],
      accountId,
      false,
      this.getSyncTimestamp(event, refetched)
    )
  }

  async handleRefundEvent(event: Stripe.Event, accountId: string): Promise<void> {
    const { entity: refund, refetched } = await this.fetchOrUseWebhookData(
      event.data.object as Stripe.Refund,
      (id) => this.deps.stripe.refunds.retrieve(id)
    )

    await this.deps.upsertAny([refund], accountId, false, this.getSyncTimestamp(event, refetched))
  }

  async handleReviewEvent(event: Stripe.Event, accountId: string): Promise<void> {
    const { entity: review, refetched } = await this.fetchOrUseWebhookData(
      event.data.object as Stripe.Review,
      (id) => this.deps.stripe.reviews.retrieve(id)
    )

    await this.deps.upsertAny([review], accountId, false, this.getSyncTimestamp(event, refetched))
  }

  async handleEntitlementSummaryEvent(event: Stripe.Event, accountId: string): Promise<void> {
    const activeEntitlementSummary = event.data
      .object as Stripe.Entitlements.ActiveEntitlementSummary
    let entitlements = activeEntitlementSummary.entitlements
    let refetched = false
    if (this.deps.config.revalidateObjectsViaStripeApi?.includes('entitlements')) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { lastResponse, ...rest } = await this.deps.stripe.entitlements.activeEntitlements.list(
        {
          customer: activeEntitlementSummary.customer,
        }
      )
      entitlements = rest
      refetched = true
    }

    await this.deps.postgresClient.deleteRemovedActiveEntitlements(
      activeEntitlementSummary.customer,
      entitlements.data.map((entitlement) => entitlement.id)
    )
    await this.deps.upsertAny(
      entitlements.data,
      accountId,
      false,
      this.getSyncTimestamp(event, refetched)
    )
  }

  getSyncTimestamp(event: Stripe.Event, refetched: boolean) {
    return refetched ? new Date().toISOString() : new Date(event.created * 1000).toISOString()
  }

  shouldRefetchEntity(entity: { object: string }) {
    return this.deps.config.revalidateObjectsViaStripeApi?.includes(
      entity.object as RevalidateEntity
    )
  }

  async fetchOrUseWebhookData<T extends { id?: string; object: string }>(
    entity: T,
    fetchFn: (id: string) => Promise<T>,
    entityInFinalState?: (entity: T) => boolean
  ): Promise<{ entity: T; refetched: boolean }> {
    if (!entity.id) return { entity, refetched: false }
    if (entityInFinalState && entityInFinalState(entity)) return { entity, refetched: false }

    if (this.shouldRefetchEntity(entity)) {
      const fetchedEntity = await fetchFn(entity.id)
      return { entity: fetchedEntity, refetched: true }
    }

    return { entity, refetched: false }
  }

  async findOrCreateManagedWebhook(
    url: string,
    params?: Omit<Stripe.WebhookEndpointCreateParams, 'url'>
  ): Promise<Stripe.WebhookEndpoint> {
    const webhookParams = {
      enabled_events: this.getSupportedEventTypes(),
      ...params,
    }
    const accountId = await this.deps.accountIdPromise
    const lockKey = `webhook:${accountId}:${url}`

    return this.deps.postgresClient.withAdvisoryLock(lockKey, async () => {
      const existingWebhook = await this.getManagedWebhookByUrl(url)

      if (existingWebhook) {
        try {
          const stripeWebhook = await this.deps.stripe.webhookEndpoints.retrieve(existingWebhook.id)
          if (stripeWebhook.status === 'enabled') {
            return stripeWebhook
          }
          this.deps.config.logger?.info(
            { webhookId: existingWebhook.id },
            'Webhook is disabled, deleting and will recreate'
          )
          await this.deps.stripe.webhookEndpoints.del(existingWebhook.id)
          await this.deps.postgresClient.delete('_managed_webhooks', existingWebhook.id)
        } catch (error) {
          const stripeError = error as { statusCode?: number; code?: string }
          if (stripeError?.statusCode === 404 || stripeError?.code === 'resource_missing') {
            this.deps.config.logger?.warn(
              { error, webhookId: existingWebhook.id },
              'Webhook not found in Stripe (404), removing from database'
            )
            await this.deps.postgresClient.delete('_managed_webhooks', existingWebhook.id)
          } else {
            this.deps.config.logger?.error(
              { error, webhookId: existingWebhook.id },
              'Error retrieving webhook from Stripe, keeping in database'
            )
            throw error
          }
        }
      }

      const allDbWebhooks = await this.listManagedWebhooks()
      for (const dbWebhook of allDbWebhooks) {
        if (dbWebhook.url !== url) {
          this.deps.config.logger?.info(
            { webhookId: dbWebhook.id, oldUrl: dbWebhook.url, newUrl: url },
            'Webhook URL mismatch, deleting'
          )
          try {
            await this.deps.stripe.webhookEndpoints.del(dbWebhook.id)
          } catch (error) {
            this.deps.config.logger?.warn(
              { error, webhookId: dbWebhook.id },
              'Failed to delete old webhook from Stripe'
            )
          }
          await this.deps.postgresClient.delete('_managed_webhooks', dbWebhook.id)
        }
      }

      try {
        const stripeWebhooks = await this.deps.stripe.webhookEndpoints.list({ limit: 100 })

        for (const stripeWebhook of stripeWebhooks.data) {
          const isManagedByMetadata =
            stripeWebhook.metadata?.managed_by?.toLowerCase().replace(/[\s\-]+/g, '') ===
            'stripesync'
          const normalizedDescription =
            stripeWebhook.description?.toLowerCase().replace(/[\s\-]+/g, '') || ''
          const isManagedByDescription = normalizedDescription.includes('stripesync')

          if (isManagedByMetadata || isManagedByDescription) {
            const existsInDb = allDbWebhooks.some((dbWebhook) => dbWebhook.id === stripeWebhook.id)
            if (!existsInDb) {
              this.deps.config.logger?.warn(
                { webhookId: stripeWebhook.id, url: stripeWebhook.url },
                'Found orphaned managed webhook in Stripe, deleting'
              )
              await this.deps.stripe.webhookEndpoints.del(stripeWebhook.id)
            }
          }
        }
      } catch (error) {
        this.deps.config.logger?.warn({ error }, 'Failed to check for orphaned webhooks')
      }

      const webhook = await this.deps.stripe.webhookEndpoints.create({
        ...webhookParams,
        url,
        metadata: {
          ...webhookParams.metadata,
          managed_by: 'stripe-sync',
          version: pkg.version,
        },
      })

      await this.upsertManagedWebhooks([webhook], accountId)
      return webhook
    })
  }

  async getManagedWebhook(id: string): Promise<Stripe.WebhookEndpoint | null> {
    const accountId = await this.deps.accountIdPromise
    const result = await this.deps.postgresClient.query(
      `SELECT * FROM "stripe"."_managed_webhooks" WHERE id = $1 AND "account_id" = $2`,
      [id, accountId]
    )
    return result.rows.length > 0 ? (result.rows[0] as Stripe.WebhookEndpoint) : null
  }

  async getManagedWebhookByUrl(url: string): Promise<Stripe.WebhookEndpoint | null> {
    const accountId = await this.deps.accountIdPromise
    const result = await this.deps.postgresClient.query(
      `SELECT * FROM "stripe"."_managed_webhooks" WHERE url = $1 AND "account_id" = $2`,
      [url, accountId]
    )
    return result.rows.length > 0 ? (result.rows[0] as Stripe.WebhookEndpoint) : null
  }

  async listManagedWebhooks(): Promise<Array<Stripe.WebhookEndpoint>> {
    const accountId = await this.deps.accountIdPromise
    const result = await this.deps.postgresClient.query(
      `SELECT * FROM "stripe"."_managed_webhooks" WHERE "account_id" = $1 ORDER BY created DESC`,
      [accountId]
    )
    return result.rows as Array<Stripe.WebhookEndpoint>
  }

  async updateManagedWebhook(
    id: string,
    params: Stripe.WebhookEndpointUpdateParams
  ): Promise<Stripe.WebhookEndpoint> {
    const webhook = await this.deps.stripe.webhookEndpoints.update(id, params)
    const accountId = await this.deps.accountIdPromise
    await this.upsertManagedWebhooks([webhook], accountId)
    return webhook
  }

  async deleteManagedWebhook(id: string): Promise<boolean> {
    await this.deps.stripe.webhookEndpoints.del(id)
    return this.deps.postgresClient.delete('_managed_webhooks', id)
  }

  async upsertManagedWebhooks(
    webhooks: Array<Stripe.WebhookEndpoint>,
    accountId: string,
    syncTimestamp?: string
  ): Promise<Array<Stripe.WebhookEndpoint>> {
    const filteredWebhooks = webhooks.map((webhook) => {
      const filtered: Record<string, unknown> = {}
      for (const prop of managedWebhookSchema.properties) {
        if (prop in webhook) {
          filtered[prop] = webhook[prop as keyof typeof webhook]
        }
      }
      return filtered
    })

    return this.deps.postgresClient.upsertManyWithTimestampProtection(
      filteredWebhooks as unknown as Array<Stripe.WebhookEndpoint>,
      '_managed_webhooks',
      accountId,
      syncTimestamp
    )
  }
}
