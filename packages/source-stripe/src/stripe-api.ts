import { createHmac, timingSafeEqual } from 'node:crypto'
import type {
  StripeAccount,
  StripeEvent,
  StripeList,
  StripeWebhookEndpoint,
} from './stripe-types.js'
import { fetchWithProxy } from './transport.js'

export interface StripeClientConfig {
  apiKey: string
  baseUrl?: string
}

const DEFAULT_BASE = 'https://api.stripe.com'

function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` }
}

async function stripeGet<T>(
  config: StripeClientConfig,
  path: string,
  qs?: URLSearchParams
): Promise<T> {
  const base = config.baseUrl ?? DEFAULT_BASE
  const url = qs?.toString() ? `${base}${path}?${qs}` : `${base}${path}`
  const res = await fetchWithProxy(url, { headers: authHeaders(config.apiKey) })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Stripe API error ${res.status}: ${body}`)
  }
  return (await res.json()) as T
}

async function stripePost<T>(
  config: StripeClientConfig,
  path: string,
  body?: URLSearchParams
): Promise<T> {
  const base = config.baseUrl ?? DEFAULT_BASE
  const res = await fetchWithProxy(`${base}${path}`, {
    method: 'POST',
    headers: {
      ...authHeaders(config.apiKey),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body?.toString(),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Stripe API error ${res.status}: ${text}`)
  }
  return (await res.json()) as T
}

async function stripeDelete(config: StripeClientConfig, path: string): Promise<void> {
  const base = config.baseUrl ?? DEFAULT_BASE
  const res = await fetchWithProxy(`${base}${path}`, {
    method: 'DELETE',
    headers: authHeaders(config.apiKey),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Stripe API error ${res.status}: ${text}`)
  }
}

export async function retrieveAccount(config: StripeClientConfig): Promise<StripeAccount> {
  return stripeGet<StripeAccount>(config, '/v1/account')
}

export async function listWebhookEndpoints(
  config: StripeClientConfig,
  params?: { limit?: number }
): Promise<StripeList<StripeWebhookEndpoint>> {
  const qs = new URLSearchParams()
  if (params?.limit) qs.set('limit', String(params.limit))
  return stripeGet(config, '/v1/webhook_endpoints', qs)
}

export async function createWebhookEndpoint(
  config: StripeClientConfig,
  params: { url: string; enabled_events: string[]; metadata?: Record<string, string> }
): Promise<StripeWebhookEndpoint> {
  const body = new URLSearchParams()
  body.set('url', params.url)
  for (const event of params.enabled_events) {
    body.append('enabled_events[]', event)
  }
  if (params.metadata) {
    for (const [key, value] of Object.entries(params.metadata)) {
      body.set(`metadata[${key}]`, value)
    }
  }
  return stripePost(config, '/v1/webhook_endpoints', body)
}

export async function deleteWebhookEndpoint(config: StripeClientConfig, id: string): Promise<void> {
  return stripeDelete(config, `/v1/webhook_endpoints/${id}`)
}

export async function* listAllEvents(
  config: StripeClientConfig,
  params: { created?: { gt?: number } }
): AsyncGenerator<StripeEvent> {
  let startingAfter: string | undefined
  let hasMore = true

  while (hasMore) {
    const qs = new URLSearchParams()
    qs.set('limit', '100')
    if (startingAfter) qs.set('starting_after', startingAfter)
    if (params.created?.gt != null) qs.set('created[gt]', String(params.created.gt))

    const result = await stripeGet<StripeList<StripeEvent>>(config, '/v1/events', qs)

    for (const event of result.data) {
      yield event
    }

    hasMore = result.has_more
    if (result.data.length > 0) {
      startingAfter = result.data[result.data.length - 1].id
    }
  }
}

const DEFAULT_TOLERANCE = 300

export function verifyWebhookSignature(
  payload: string | Buffer,
  signature: string,
  secret: string,
  tolerance = DEFAULT_TOLERANCE
): StripeEvent {
  const pairs: Record<string, string> = {}
  for (const element of signature.split(',')) {
    const idx = element.indexOf('=')
    if (idx > 0) {
      pairs[element.slice(0, idx)] = element.slice(idx + 1)
    }
  }

  const timestamp = parseInt(pairs.t, 10)
  const sig = pairs.v1

  if (!timestamp || !sig) {
    throw new Error('Unable to extract timestamp and signatures from header')
  }

  const now = Math.floor(Date.now() / 1000)
  if (tolerance > 0 && Math.abs(now - timestamp) > tolerance) {
    throw new Error('Webhook timestamp outside the tolerance zone')
  }

  const payloadStr = typeof payload === 'string' ? payload : payload.toString('utf8')
  const expectedSig = createHmac('sha256', secret)
    .update(`${timestamp}.${payloadStr}`)
    .digest('hex')

  const a = Buffer.from(sig, 'utf8')
  const b = Buffer.from(expectedSig, 'utf8')

  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error('No signatures found matching the expected signature for payload')
  }

  return JSON.parse(payloadStr) as StripeEvent
}
