/**
 * Real Stripe SDK client for integration tests
 * Uses actual API keys from environment variables
 */
import Stripe from 'stripe'

export function getStripeClient(keyEnvVar = 'STRIPE_API_KEY'): Stripe {
  const apiKey = process.env[keyEnvVar]
  if (!apiKey) {
    throw new Error(`Environment variable ${keyEnvVar} is not set`)
  }
  return new Stripe(apiKey)
}

export function checkEnvVars(...vars: string[]): void {
  const missing = vars.filter((v) => !process.env[v])
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`)
  }
}
