/** Wire shapes for Stripe JSON (no SDK). */

export interface StripeEvent {
  id: string
  object: 'event'
  type: string
  created: number
  api_version: string | null
  livemode: boolean
  pending_webhooks: number
  request: { id: string | null; idempotency_key: string | null } | null
  data: {
    object: Record<string, unknown> & { id?: string; object?: string; deleted?: boolean }
  }
}

export interface StripeList<T> {
  object: 'list'
  data: T[]
  has_more: boolean
  url?: string
}

export interface StripeAccount {
  id: string
  object: 'account'
  [key: string]: unknown
}

export interface StripeWebhookEndpoint {
  id: string
  object: 'webhook_endpoint'
  url: string
  status: string
  enabled_events: string[]
  metadata: Record<string, string> | null
  [key: string]: unknown
}
