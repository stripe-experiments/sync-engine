import Stripe from 'stripe'
import { HttpsProxyAgent } from 'https-proxy-agent'

type StripeEnv = Record<string, string | undefined>

export type StripeClientConfigInput = {
  api_key: string
  base_url?: string
}

function parsePositiveInteger(
  name: string,
  value: string | undefined,
  defaultValue: number
): number {
  const parsed = Number(value ?? defaultValue)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return parsed
}

export function getStripeProxyUrl(env: StripeEnv = process.env): string | undefined {
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
    const value = env[key]?.trim()
    if (value) {
      return value
    }
  }
  return undefined
}

function buildBaseUrlOptions(
  baseUrl: string
): Pick<Stripe.StripeConfig, 'host' | 'port' | 'protocol'> {
  const url = new URL(baseUrl)
  return {
    host: url.hostname,
    port: url.port ? parseInt(url.port, 10) : url.protocol === 'https:' ? 443 : 80,
    protocol: url.protocol.replace(':', '') as Stripe.HttpProtocol,
  }
}

export function buildStripeClientOptions(
  config: StripeClientConfigInput,
  env: StripeEnv = process.env
): Stripe.StripeConfig {
  const options: Stripe.StripeConfig = {
    timeout: parsePositiveInteger(
      'STRIPE_REQUEST_TIMEOUT_MS',
      env.STRIPE_REQUEST_TIMEOUT_MS,
      10_000
    ),
  }

  if (config.base_url) {
    return {
      ...options,
      ...buildBaseUrlOptions(config.base_url),
    }
  }

  const proxyUrl = getStripeProxyUrl(env)
  if (proxyUrl) {
    options.httpAgent = new HttpsProxyAgent(proxyUrl)
  }

  return options
}

function attachStripeRequestLogging(stripe: Stripe, env: StripeEnv = process.env): void {
  if (env.STRIPE_LOG_REQUESTS !== '1') {
    return
  }

  stripe.on('request', (event) => {
    console.info({
      msg: 'Stripe API request started',
      method: event.method,
      path: event.path,
      apiVersion: event.api_version,
      requestStartTime: event.request_start_time,
    })
  })

  stripe.on('response', (event) => {
    console.info({
      msg: 'Stripe API request completed',
      method: event.method,
      path: event.path,
      status: event.status,
      elapsed: event.elapsed,
      requestId: event.request_id,
      apiVersion: event.api_version,
    })
  })
}

export function makeClient(config: StripeClientConfigInput, env: StripeEnv = process.env): Stripe {
  const stripe = new Stripe(config.api_key, buildStripeClientOptions(config, env))
  attachStripeRequestLogging(stripe, env)
  return stripe
}
