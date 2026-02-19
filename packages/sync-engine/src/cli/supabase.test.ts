import { describe, test, expect } from 'vitest'
import { webhookFunctionCode, workerFunctionCode, sigmaWorkerFunctionCode } from '../supabase'

describe('Edge Function Files', () => {
  describe('webhookFunctionCode', () => {
    test('imports StripeSync from npm', () => {
      expect(webhookFunctionCode).toContain("import { StripeSync } from '")
    })

    test('uses poolConfig for database connection', () => {
      expect(webhookFunctionCode).toContain('poolConfig:')
      expect(webhookFunctionCode).toContain('connectionString: dbUrl')
    })

    test('uses SUPABASE_DB_URL environment variable', () => {
      expect(webhookFunctionCode).toContain("Deno.env.get('SUPABASE_DB_URL')")
    })

    test('uses STRIPE_SECRET_KEY environment variable', () => {
      expect(webhookFunctionCode).toContain("Deno.env.get('STRIPE_SECRET_KEY')")
    })

    test('validates stripe-signature header', () => {
      expect(webhookFunctionCode).toContain("req.headers.get('stripe-signature')")
      expect(webhookFunctionCode).toContain('Missing stripe-signature header')
    })

    test('calls processWebhook with raw body and signature', () => {
      expect(webhookFunctionCode).toContain('stripeSync.webhook.processWebhook(rawBody, sig)')
    })

    test('returns 200 on success', () => {
      expect(webhookFunctionCode).toContain('status: 200')
      expect(webhookFunctionCode).toContain('received: true')
    })

    test('returns 400 on error', () => {
      expect(webhookFunctionCode).toContain('status: 400')
    })

    test('rejects non-POST requests', () => {
      expect(webhookFunctionCode).toContain("req.method !== 'POST'")
      expect(webhookFunctionCode).toContain('status: 405')
    })
  })

  describe('workerFunctionCode', () => {
    test('imports postgres from npm for vault secret validation', () => {
      expect(workerFunctionCode).toContain("import postgres from 'npm:postgres'")
    })

    test('uses poolConfig for database connection', () => {
      expect(workerFunctionCode).toContain('poolConfig:')
      expect(workerFunctionCode).toContain('connectionString: dbUrl')
    })

    test('uses SUPABASE_DB_URL environment variable', () => {
      expect(workerFunctionCode).toContain("Deno.env.get('SUPABASE_DB_URL')")
    })

    test('uses STRIPE_SECRET_KEY environment variable', () => {
      expect(workerFunctionCode).toContain("Deno.env.get('STRIPE_SECRET_KEY')")
    })

    test('verifies authorization header', () => {
      expect(workerFunctionCode).toContain("req.headers.get('Authorization')")
      expect(workerFunctionCode).toContain("startsWith('Bearer ')")
    })

    test('returns 401 for unauthorized requests', () => {
      expect(workerFunctionCode).toContain('Unauthorized')
      expect(workerFunctionCode).toContain('status: 401')
    })

    test('validates worker secret against vault', () => {
      expect(workerFunctionCode).toContain('stripe_sync_worker_secret')
      expect(workerFunctionCode).toContain('Forbidden: Invalid worker secret')
    })

    test('initializes sync run via object-run model', () => {
      expect(workerFunctionCode).toContain('stripe-worker')
      expect(workerFunctionCode).toContain('tableNames')
    })

    test('runs StripeSyncWorker and waits for completion', () => {
      expect(workerFunctionCode).toContain('new StripeSyncWorker')
      expect(workerFunctionCode).toContain('worker.start()')
      expect(workerFunctionCode).toContain('worker.waitUntilDone()')
    })

    test('returns synced totals from object runs', () => {
      expect(workerFunctionCode).toContain('getObjectSyncedCounts')
      expect(workerFunctionCode).toContain('JSON.stringify({ totals })')
    })

    test('returns 200 on success', () => {
      expect(workerFunctionCode).toContain('status: 200')
    })

    test('returns 500 on error', () => {
      expect(workerFunctionCode).toContain('status: 500')
    })
  })

  describe('sigmaWorkerFunctionCode', () => {
    test('imports StripeSync from npm', () => {
      expect(sigmaWorkerFunctionCode).toContain("import { StripeSync } from '")
    })

    test('imports postgres from npm for database operations', () => {
      expect(sigmaWorkerFunctionCode).toContain("import postgres from 'npm:postgres'")
    })

    test('uses poolConfig for database connection', () => {
      expect(sigmaWorkerFunctionCode).toContain('poolConfig:')
      expect(sigmaWorkerFunctionCode).toContain('connectionString: dbUrl')
    })

    test('uses SUPABASE_DB_URL environment variable', () => {
      expect(sigmaWorkerFunctionCode).toContain("Deno.env.get('SUPABASE_DB_URL')")
    })

    test('uses STRIPE_SECRET_KEY environment variable', () => {
      expect(sigmaWorkerFunctionCode).toContain("Deno.env.get('STRIPE_SECRET_KEY')")
    })

    test('verifies authorization header', () => {
      expect(sigmaWorkerFunctionCode).toContain("req.headers.get('Authorization')")
      expect(sigmaWorkerFunctionCode).toContain("startsWith('Bearer ')")
    })

    test('returns 401 for unauthorized requests', () => {
      expect(sigmaWorkerFunctionCode).toContain('Unauthorized')
      expect(sigmaWorkerFunctionCode).toContain('status: 401')
    })

    test('uses sigma-specific vault secret', () => {
      expect(sigmaWorkerFunctionCode).toContain('stripe_sigma_worker_secret')
    })

    test('enables sigma mode', () => {
      expect(sigmaWorkerFunctionCode).toContain('enableSigma: true')
    })

    test('initializes sigma sync run and object runs', () => {
      expect(sigmaWorkerFunctionCode).toContain('getSupportedSigmaObjects')
      expect(sigmaWorkerFunctionCode).toContain('getOrCreateSyncRun')
      expect(sigmaWorkerFunctionCode).toContain('createObjectRuns')
    })

    test('claims pending objects via object runs', () => {
      expect(sigmaWorkerFunctionCode).toContain('listObjectsByStatus')
      expect(sigmaWorkerFunctionCode).toContain('tryStartObjectSync')
    })

    test('calls processNext for each object', () => {
      expect(sigmaWorkerFunctionCode).toContain('processNext')
    })

    test('self-triggers via trigger function', () => {
      expect(sigmaWorkerFunctionCode).toContain('trigger_sigma_worker')
    })

    test('uses JSON responses', () => {
      expect(sigmaWorkerFunctionCode).toContain('jsonResponse')
    })

    test('returns 500 on error', () => {
      expect(sigmaWorkerFunctionCode).toContain('jsonResponse({ error')
      expect(sigmaWorkerFunctionCode).toContain('500')
    })
  })
})

describe('Database URL Construction', () => {
  test('constructs pooler URL with correct format', () => {
    const projectRef = 'abcdefghijklmnopqrst'
    const region = 'us-east-1'
    const password = 'mypassword123'
    const encodedPassword = encodeURIComponent(password)

    const databaseUrl = `postgresql://postgres.${projectRef}:${encodedPassword}@aws-0-${region}.pooler.supabase.com:6543/postgres`

    expect(databaseUrl).toBe(
      'postgresql://postgres.abcdefghijklmnopqrst:mypassword123@aws-0-us-east-1.pooler.supabase.com:6543/postgres'
    )
  })

  test('encodes special characters in password', () => {
    const projectRef = 'abcdefghijklmnopqrst'
    const region = 'us-east-1'
    const password = 'pass@word#123!'
    const encodedPassword = encodeURIComponent(password)

    const databaseUrl = `postgresql://postgres.${projectRef}:${encodedPassword}@aws-0-${region}.pooler.supabase.com:6543/postgres`

    expect(databaseUrl).toContain('pass%40word%23123!')
    expect(databaseUrl).not.toContain('pass@word#123!')
  })
})

describe('Webhook URL Generation', () => {
  test('webhook URL uses correct format', () => {
    const projectRef = 'abcdefghijklmnopqrst'
    const webhookUrl = `https://${projectRef}.supabase.co/functions/v1/stripe-webhook`

    expect(webhookUrl).toBe('https://abcdefghijklmnopqrst.supabase.co/functions/v1/stripe-webhook')
  })
})
