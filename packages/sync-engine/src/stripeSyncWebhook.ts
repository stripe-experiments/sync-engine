import Stripe from 'stripe'
import pkg from '../package.json' with { type: 'json' }
import { managedWebhookSchema } from './schemas/managed_webhook'
import { type RevalidateEntity, type StripeSyncConfig, type ResourceConfig } from './types'
import { PostgresClient } from './database/postgres'
import { getResourceConfigFromId, getResourceName } from './resourceRegistry'

export type StripeSyncWebhookDeps = {
  stripe: Stripe
  postgresClient: PostgresClient
  config: StripeSyncConfig
  accountIdPromise: Promise<string>
  getCurrentAccount: (objectAccountId?: string) => Promise<Stripe.Account | null>
  upsertAny: (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    items: any[],
    accountId: string,
    backfillRelatedEntities?: boolean,
    syncTimestamp?: string
  ) => Promise<unknown[]>
  resourceRegistry: Record<string, ResourceConfig>
}

export class StripeSyncWebhook {
  // Note: Uses 'any' for event parameter to allow handlers with specific Stripe event types.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly eventHandlers: Record<string, (event: any, accountId: string) => Promise<void>>

  constructor(private readonly deps: StripeSyncWebhookDeps) {
    this.eventHandlers = {
      'charge.captured': this.handleAnyEvent.bind(this),
      'charge.expired': this.handleAnyEvent.bind(this),
      'charge.failed': this.handleAnyEvent.bind(this),
      'charge.pending': this.handleAnyEvent.bind(this),
      'charge.refunded': this.handleAnyEvent.bind(this),
      'charge.succeeded': this.handleAnyEvent.bind(this),
      'charge.updated': this.handleAnyEvent.bind(this),
      'customer.deleted': this.handleAnyEvent.bind(this),
      'customer.created': this.handleAnyEvent.bind(this),
      'customer.updated': this.handleAnyEvent.bind(this),
      'checkout.session.async_payment_failed': this.handleAnyEvent.bind(this),
      'checkout.session.async_payment_succeeded': this.handleAnyEvent.bind(this),
      'checkout.session.completed': this.handleAnyEvent.bind(this),
      'checkout.session.expired': this.handleAnyEvent.bind(this),
      'customer.subscription.created': this.handleAnyEvent.bind(this),
      'customer.subscription.deleted': this.handleAnyEvent.bind(this),
      'customer.subscription.paused': this.handleAnyEvent.bind(this),
      'customer.subscription.pending_update_applied': this.handleAnyEvent.bind(this),
      'customer.subscription.pending_update_expired': this.handleAnyEvent.bind(this),
      'customer.subscription.trial_will_end': this.handleAnyEvent.bind(this),
      'customer.subscription.resumed': this.handleAnyEvent.bind(this),
      'customer.subscription.updated': this.handleAnyEvent.bind(this),
      'customer.tax_id.updated': this.handleAnyEvent.bind(this),
      'customer.tax_id.created': this.handleAnyEvent.bind(this),
      'customer.tax_id.deleted': this.handleAnyEvent.bind(this),
      'invoice.created': this.handleAnyEvent.bind(this),
      'invoice.deleted': this.handleAnyEvent.bind(this),
      'invoice.finalized': this.handleAnyEvent.bind(this),
      'invoice.finalization_failed': this.handleAnyEvent.bind(this),
      'invoice.paid': this.handleAnyEvent.bind(this),
      'invoice.payment_action_required': this.handleAnyEvent.bind(this),
      'invoice.payment_failed': this.handleAnyEvent.bind(this),
      'invoice.payment_succeeded': this.handleAnyEvent.bind(this),
      'invoice.upcoming': this.handleAnyEvent.bind(this),
      'invoice.sent': this.handleAnyEvent.bind(this),
      'invoice.voided': this.handleAnyEvent.bind(this),
      'invoice.marked_uncollectible': this.handleAnyEvent.bind(this),
      'invoice.updated': this.handleAnyEvent.bind(this),
      'product.created': this.handleAnyEvent.bind(this),
      'product.updated': this.handleAnyEvent.bind(this),
      'product.deleted': this.handleAnyEvent.bind(this),
      'price.created': this.handleAnyEvent.bind(this),
      'price.updated': this.handleAnyEvent.bind(this),
      'price.deleted': this.handleAnyEvent.bind(this),
      'plan.created': this.handleAnyEvent.bind(this),
      'plan.updated': this.handleAnyEvent.bind(this),
      'plan.deleted': this.handleAnyEvent.bind(this),
      'setup_intent.canceled': this.handleAnyEvent.bind(this),
      'setup_intent.created': this.handleAnyEvent.bind(this),
      'setup_intent.requires_action': this.handleAnyEvent.bind(this),
      'setup_intent.setup_failed': this.handleAnyEvent.bind(this),
      'setup_intent.succeeded': this.handleAnyEvent.bind(this),
      'subscription_schedule.aborted': this.handleAnyEvent.bind(this),
      'subscription_schedule.canceled': this.handleAnyEvent.bind(this),
      'subscription_schedule.completed': this.handleAnyEvent.bind(this),
      'subscription_schedule.created': this.handleAnyEvent.bind(this),
      'subscription_schedule.expiring': this.handleAnyEvent.bind(this),
      'subscription_schedule.released': this.handleAnyEvent.bind(this),
      'subscription_schedule.updated': this.handleAnyEvent.bind(this),
      'payment_method.attached': this.handleAnyEvent.bind(this),
      'payment_method.automatically_updated': this.handleAnyEvent.bind(this),
      'payment_method.detached': this.handleAnyEvent.bind(this),
      'payment_method.updated': this.handleAnyEvent.bind(this),
      'charge.dispute.created': this.handleAnyEvent.bind(this),
      'charge.dispute.funds_reinstated': this.handleAnyEvent.bind(this),
      'charge.dispute.funds_withdrawn': this.handleAnyEvent.bind(this),
      'charge.dispute.updated': this.handleAnyEvent.bind(this),
      'charge.dispute.closed': this.handleAnyEvent.bind(this),
      'payment_intent.amount_capturable_updated': this.handleAnyEvent.bind(this),
      'payment_intent.canceled': this.handleAnyEvent.bind(this),
      'payment_intent.created': this.handleAnyEvent.bind(this),
      'payment_intent.partially_funded': this.handleAnyEvent.bind(this),
      'payment_intent.payment_failed': this.handleAnyEvent.bind(this),
      'payment_intent.processing': this.handleAnyEvent.bind(this),
      'payment_intent.requires_action': this.handleAnyEvent.bind(this),
      'payment_intent.succeeded': this.handleAnyEvent.bind(this),
      'credit_note.created': this.handleAnyEvent.bind(this),
      'credit_note.updated': this.handleAnyEvent.bind(this),
      'credit_note.voided': this.handleAnyEvent.bind(this),
      'radar.early_fraud_warning.created': this.handleAnyEvent.bind(this),
      'radar.early_fraud_warning.updated': this.handleAnyEvent.bind(this),
      'refund.created': this.handleAnyEvent.bind(this),
      'refund.failed': this.handleAnyEvent.bind(this),
      'refund.updated': this.handleAnyEvent.bind(this),
      'charge.refund.updated': this.handleAnyEvent.bind(this),
      'review.closed': this.handleAnyEvent.bind(this),
      'review.opened': this.handleAnyEvent.bind(this),
      'entitlements.active_entitlement_summary.updated': this.handleAnyEvent.bind(this),
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
    await this.handleAnyEvent(event, accountId)
  }

  public getSupportedEventTypes(): Stripe.WebhookEndpointCreateParams.EnabledEvent[] {
    return Object.keys(
      this.eventHandlers
    ).sort() as Stripe.WebhookEndpointCreateParams.EnabledEvent[]
  }

  async handleDeletedEvent(event: Stripe.Event, accountId: string): Promise<void> {
    const objectType = event.data.object.object
    const tableName = getResourceName(objectType)
    const softDelete = await this.deps.postgresClient.columnExists(tableName, 'deleted')
    const stripeObject = event.data.object as { id: string; object: string }
    if (softDelete) {
      const deletedObject = { ...stripeObject, deleted: true }
      await this.deps.upsertAny(
        [deletedObject],
        accountId,
        false,
        this.getSyncTimestamp(event, false)
      )
    } else {
      await this.deps.postgresClient.delete(tableName, stripeObject.id)
    }
  }

  async defaultHandler(event: Stripe.Event, accountId: string): Promise<void> {
    let stripeObject = event.data.object
    const objectType = event.data.object.object
    const config = this.deps.resourceRegistry[objectType]
    if (!config || !config.retrieveFn) {
      throw new Error(`Unsupported object type for handleAnyEvent: ${objectType}`)
    }
    let refetched: boolean = false
    const isFinalState = config.isFinalState && config.isFinalState(event.data.object)
    if (!isFinalState && 'id' in stripeObject) {
      stripeObject = await config.retrieveFn(stripeObject.id)
      refetched = true
    }
    await this.deps.upsertAny(
      [stripeObject],
      accountId,
      false,
      this.getSyncTimestamp(event, refetched)
    )
  }

  async handleAnyEvent(event: Stripe.Event, accountId: string): Promise<void> {
    if (event.type.includes('.deleted')) {
      await this.handleDeletedEvent(event, accountId)
    } else {
      await this.defaultHandler(event, accountId)
    }
  }

  getSyncTimestamp(event: Stripe.Event, refetched: boolean) {
    return refetched ? new Date().toISOString() : new Date(event.created * 1000).toISOString()
  }

  shouldRefetchEntity(entity: { object: string }) {
    return this.deps.config.revalidateObjectsViaStripeApi?.includes(
      entity.object as RevalidateEntity
    )
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
