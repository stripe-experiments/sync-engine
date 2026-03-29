import type { StripeClientConfig } from './stripe-api.js'
import { parsePositiveInteger, type TransportEnv } from './transport.js'

export type StripeClientConfigInput = {
  api_key: string
  base_url?: string
}
export { getProxyUrl as getStripeProxyUrl } from './transport.js'

const DEFAULT_STRIPE_API_BASE = 'https://api.stripe.com'

export interface TransportOptions {
  timeout_ms: number
  base_url: string
  host: string
  port: number
  protocol: string
}

export function buildTransportOptions(
  config: StripeClientConfigInput,
  env: TransportEnv = process.env
): TransportOptions {
  const base = config.base_url ?? DEFAULT_STRIPE_API_BASE
  const url = new URL(base)
  return {
    timeout_ms: parsePositiveInteger(
      'STRIPE_REQUEST_TIMEOUT_MS',
      env.STRIPE_REQUEST_TIMEOUT_MS,
      10_000
    ),
    base_url: base,
    host: url.hostname,
    port: url.port ? parseInt(url.port, 10) : url.protocol === 'https:' ? 443 : 80,
    protocol: url.protocol.replace(':', ''),
  }
}

export function makeClientConfig(config: StripeClientConfigInput): StripeClientConfig {
  return {
    apiKey: config.api_key,
    baseUrl: config.base_url,
  }
}
