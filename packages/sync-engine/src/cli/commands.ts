import chalk from 'chalk'
import express from 'express'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import dotenv from 'dotenv'
import { type PoolConfig } from 'pg'
import { loadConfig, type CliOptions } from './config'
import {
  StripeSync,
  runMigrations,
  createStripeWebSocketClient,
  type SyncObject,
  type StripeWebSocketClient,
  type StripeWebhookEvent,
} from '../index'
import { createTunnel, type NgrokTunnel } from './ngrok'
import {
  install,
  uninstall,
  setupFunctionCode,
  webhookFunctionCode,
  workerFunctionCode,
} from '../supabase'

export interface DeployOptions {
  supabaseAccessToken?: string
  supabaseProjectRef?: string
  stripeKey?: string
  packageVersion?: string
  workerInterval?: number
  supabaseManagementUrl?: string
  local?: boolean
  dockerPath?: string
  ngrokToken?: string
}

export type { CliOptions }

const VALID_SYNC_OBJECTS: SyncObject[] = [
  'all',
  'customer',
  'customer_with_entitlements',
  'invoice',
  'price',
  'product',
  'subscription',
  'subscription_schedules',
  'setup_intent',
  'payment_method',
  'dispute',
  'charge',
  'payment_intent',
  'plan',
  'tax_id',
  'credit_note',
  'early_fraud_warning',
  'refund',
  'checkout_sessions',
  'subscription_item_change_events_v2_beta',
  'exchange_rates_from_usd',
]

/**
 * Backfill command - backfills a specific entity type from Stripe.
 */
export async function backfillCommand(options: CliOptions, entityName: string): Promise<void> {
  let stripeSync: StripeSync | null = null

  try {
    // Validate entity name
    if (!VALID_SYNC_OBJECTS.includes(entityName as SyncObject)) {
      console.error(
        chalk.red(
          `Error: Invalid entity name "${entityName}". Valid entities are: ${VALID_SYNC_OBJECTS.join(', ')}`
        )
      )
      process.exit(1)
    }

    // For backfill, we only need stripe key and database URL (not ngrok token)
    dotenv.config()

    let stripeApiKey =
      options.stripeKey || process.env.STRIPE_API_KEY || process.env.STRIPE_SECRET_KEY || ''
    let databaseUrl = options.databaseUrl || process.env.DATABASE_URL || ''

    if (!stripeApiKey || !databaseUrl) {
      const inquirer = (await import('inquirer')).default
      const questions = []

      if (!stripeApiKey) {
        questions.push({
          type: 'password',
          name: 'stripeApiKey',
          message: 'Enter your Stripe API key:',
          mask: '*',
          validate: (input: string) => {
            if (!input || input.trim() === '') {
              return 'Stripe API key is required'
            }
            if (!input.startsWith('sk_') && !input.startsWith('rk_')) {
              return 'Stripe API key should start with "sk_" or "rk_"'
            }
            return true
          },
        })
      }

      if (!databaseUrl) {
        questions.push({
          type: 'password',
          name: 'databaseUrl',
          message: 'Enter your Postgres DATABASE_URL:',
          mask: '*',
          validate: (input: string) => {
            if (!input || input.trim() === '') {
              return 'DATABASE_URL is required'
            }
            if (!input.startsWith('postgres://') && !input.startsWith('postgresql://')) {
              return 'DATABASE_URL should start with "postgres://" or "postgresql://"'
            }
            return true
          },
        })
      }

      if (questions.length > 0) {
        console.log(chalk.yellow('\nMissing required configuration. Please provide:'))
        const answers = await inquirer.prompt(questions)
        if (answers.stripeApiKey) stripeApiKey = answers.stripeApiKey
        if (answers.databaseUrl) databaseUrl = answers.databaseUrl
      }
    }

    const config = {
      stripeApiKey,
      databaseUrl,
      ngrokAuthToken: '', // Not needed for backfill
    }
    console.log(chalk.blue(`Backfilling ${entityName} from Stripe in 'stripe' schema...`))
    console.log(chalk.gray(`Database: ${config.databaseUrl.replace(/:[^:@]+@/, ':****@')}`))

    // Run migrations first (will check for legacy installations and throw if detected)
    try {
      await runMigrations({
        databaseUrl: config.databaseUrl,
      })
    } catch (migrationError) {
      console.error(chalk.red('Failed to run migrations:'))
      console.error(
        migrationError instanceof Error ? migrationError.message : String(migrationError)
      )
      throw migrationError
    }

    // Create StripeSync instance
    const poolConfig: PoolConfig = {
      max: 10,
      connectionString: config.databaseUrl,
      keepAlive: true,
    }

    stripeSync = new StripeSync({
      databaseUrl: config.databaseUrl,
      stripeSecretKey: config.stripeApiKey,
      enableSigma: process.env.ENABLE_SIGMA === 'true',
      stripeApiVersion: process.env.STRIPE_API_VERSION || '2020-08-27',
      autoExpandLists: process.env.AUTO_EXPAND_LISTS === 'true',
      backfillRelatedEntities: process.env.BACKFILL_RELATED_ENTITIES !== 'false',
      poolConfig,
    })

    // Run sync for the specified entity
    const result = await stripeSync.processUntilDone({ object: entityName as SyncObject })
    const totalSynced = Object.values(result).reduce(
      (sum, syncResult) => sum + (syncResult?.synced || 0),
      0
    )

    console.log(chalk.green(`✓ Backfill complete: ${totalSynced} ${entityName} objects synced`))

    // Clean up database pool
    await stripeSync.close()
  } catch (error) {
    if (error instanceof Error) {
      console.error(chalk.red(error.message))
    }

    // Clean up database pool on error
    if (stripeSync) {
      try {
        await stripeSync.close()
      } catch {
        // Ignore cleanup errors
      }
    }

    process.exit(1)
  }
}

/**
 * Migration command - runs database migrations only.
 */
export async function migrateCommand(options: CliOptions): Promise<void> {
  try {
    // For migrations, we only need the database URL
    dotenv.config()

    let databaseUrl = options.databaseUrl || process.env.DATABASE_URL || ''

    if (!databaseUrl) {
      const inquirer = (await import('inquirer')).default
      const answers = await inquirer.prompt([
        {
          type: 'password',
          name: 'databaseUrl',
          message: 'Enter your Postgres DATABASE_URL:',
          mask: '*',
          validate: (input: string) => {
            if (!input || input.trim() === '') {
              return 'DATABASE_URL is required'
            }
            if (!input.startsWith('postgres://') && !input.startsWith('postgresql://')) {
              return 'DATABASE_URL should start with "postgres://" or "postgresql://"'
            }
            return true
          },
        },
      ])
      databaseUrl = answers.databaseUrl
    }

    console.log(chalk.blue("Running database migrations in 'stripe' schema..."))
    console.log(chalk.gray(`Database: ${databaseUrl.replace(/:[^:@]+@/, ':****@')}`))

    try {
      await runMigrations({
        databaseUrl,
      })
      console.log(chalk.green('✓ Migrations completed successfully'))
    } catch (migrationError) {
      // Migration failed
      console.warn(chalk.yellow('Migrations failed.'))
      if (migrationError instanceof Error) {
        const errorMsg = migrationError.message || migrationError.toString()
        console.warn('Migration error:', errorMsg)
        if (migrationError.stack) {
          console.warn(chalk.gray(migrationError.stack))
        }
      } else {
        console.warn('Migration error:', String(migrationError))
      }
      throw migrationError
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error(chalk.red(error.message))
    }
    process.exit(1)
  }
}

/**
 * Main sync command - syncs Stripe data to PostgreSQL using webhooks for real-time updates.
 * Supports two modes:
 * - WebSocket mode (default): Direct connection to Stripe via WebSocket, no ngrok needed
 * - Webhook mode: Uses ngrok tunnel + Express server (when NGROK_AUTH_TOKEN is provided)
 */
export async function syncCommand(options: CliOptions): Promise<void> {
  let stripeSync: StripeSync | null = null
  let tunnel: NgrokTunnel | null = null
  let server: http.Server | null = null
  let webhookId: string | null = null
  let wsClient: StripeWebSocketClient | null = null

  // Setup cleanup handler
  const cleanup = async (signal?: string) => {
    console.log(chalk.blue(`\n\nCleaning up... (signal: ${signal || 'manual'})`))

    // Close WebSocket client if in WebSocket mode
    if (wsClient) {
      try {
        wsClient.close()
        console.log(chalk.green('✓ WebSocket closed'))
      } catch {
        console.log(chalk.yellow('⚠ Could not close WebSocket'))
      }
    }

    // Delete webhook endpoint if created (unless keepWebhooksOnShutdown is true)
    const keepWebhooksOnShutdown = process.env.KEEP_WEBHOOKS_ON_SHUTDOWN === 'true'
    if (webhookId && stripeSync && !keepWebhooksOnShutdown) {
      try {
        await stripeSync.deleteManagedWebhook(webhookId)
        console.log(chalk.green('✓ Webhook cleanup complete'))
      } catch {
        console.log(chalk.yellow('⚠ Could not delete webhook'))
      }
    }

    // Close server
    if (server) {
      try {
        await new Promise<void>((resolve, reject) => {
          server!.close((err) => {
            if (err) reject(err)
            else resolve()
          })
        })
        console.log(chalk.green('✓ Server stopped'))
      } catch {
        console.log(chalk.yellow('⚠ Server already stopped'))
      }
    }

    // Close tunnel
    if (tunnel) {
      try {
        await tunnel.close()
      } catch {
        console.log(chalk.yellow('⚠ Could not close tunnel'))
      }
    }

    // Close database pool
    if (stripeSync) {
      try {
        await stripeSync.close()
        console.log(chalk.green('✓ Database pool closed'))
      } catch {
        console.log(chalk.yellow('⚠ Could not close database pool'))
      }
    }

    process.exit(0)
  }

  // Register cleanup handlers
  process.on('SIGINT', () => cleanup('SIGINT'))
  process.on('SIGTERM', () => cleanup('SIGTERM'))

  try {
    // Load configuration
    const config = await loadConfig(options)

    // Determine mode based on USE_WEBSOCKET env var or ngrok token availability
    // USE_WEBSOCKET=true explicitly forces WebSocket mode (useful for tests)
    const useWebSocketMode = process.env.USE_WEBSOCKET === 'true' || !config.ngrokAuthToken
    const modeLabel = useWebSocketMode ? 'WebSocket' : 'Webhook (ngrok)'
    console.log(chalk.blue(`\nMode: ${modeLabel}`))

    // Show command with database URL (masked)
    const maskedDbUrl = config.databaseUrl.replace(/:[^:@]+@/, ':****@')
    console.log(chalk.gray(`Database: ${maskedDbUrl}`))

    // 1. Run migrations (will check for legacy installations and throw if detected)
    try {
      await runMigrations({
        databaseUrl: config.databaseUrl,
      })
    } catch (migrationError) {
      console.error(chalk.red('Failed to run migrations:'))
      console.error(
        migrationError instanceof Error ? migrationError.message : String(migrationError)
      )
      throw migrationError
    }

    // 2. Create StripeSync instance
    const poolConfig: PoolConfig = {
      max: 10,
      connectionString: config.databaseUrl,
      keepAlive: true,
    }

    stripeSync = new StripeSync({
      databaseUrl: config.databaseUrl,
      stripeSecretKey: config.stripeApiKey,
      enableSigma: config.enableSigma,
      stripeApiVersion: process.env.STRIPE_API_VERSION || '2020-08-27',
      autoExpandLists: process.env.AUTO_EXPAND_LISTS === 'true',
      backfillRelatedEntities: process.env.BACKFILL_RELATED_ENTITIES !== 'false',
      poolConfig,
    })

    // let's get a database URL without password for logging purposes
    const databaseUrlWithoutPassword = config.databaseUrl.replace(/:[^:@]+@/, ':****@')

    if (useWebSocketMode) {
      // ===== WEBSOCKET MODE =====
      console.log(chalk.blue('\nConnecting to Stripe WebSocket...'))

      wsClient = await createStripeWebSocketClient({
        stripeApiKey: config.stripeApiKey,
        onEvent: async (event: StripeWebhookEvent) => {
          try {
            const payload = JSON.parse(event.event_payload)
            console.log(chalk.cyan(`← ${payload.type}`) + chalk.gray(` (${payload.id})`))
            if (stripeSync) {
              await stripeSync.processEvent(payload)
              return {
                status: 200,
                event_type: payload.type,
                event_id: payload.id,
                databaseUrl: databaseUrlWithoutPassword,
              }
            }
          } catch (err) {
            console.error(chalk.red('Error processing event:'), err)
            return {
              status: 500,
              databaseUrl: databaseUrlWithoutPassword,
              error: err instanceof Error ? err.message : String(err),
            }
          }
        },
        onReady: (secret) => {
          console.log(chalk.green('✓ Connected to Stripe WebSocket'))
          const maskedSecret =
            secret.length > 14 ? `${secret.slice(0, 10)}...${secret.slice(-4)}` : '****'
          console.log(chalk.gray(`  Webhook secret: ${maskedSecret}`))
        },
        onError: (error) => {
          console.error(chalk.red('WebSocket error:'), error.message)
        },
        onClose: (code, reason) => {
          console.log(chalk.yellow(`WebSocket closed: ${code} - ${reason}`))
        },
      })
    } else {
      // ===== WEBHOOK MODE (ngrok) =====
      const port = 3000
      tunnel = await createTunnel(port, config.ngrokAuthToken!)

      // Create managed webhook endpoint
      const webhookPath = process.env.WEBHOOK_PATH || '/stripe-webhooks'
      console.log(chalk.blue('\nCreating Stripe webhook endpoint...'))
      const webhook = await stripeSync.findOrCreateManagedWebhook(`${tunnel.url}${webhookPath}`)
      webhookId = webhook.id
      const eventCount = webhook.enabled_events?.length || 0
      console.log(chalk.green(`✓ Webhook created: ${webhook.id}`))
      console.log(chalk.cyan(`  URL: ${webhook.url}`))
      console.log(chalk.cyan(`  Events: ${eventCount} supported events`))

      // Create Express app and mount webhook handler
      const app = express()
      const webhookRoute = webhookPath
      app.use(webhookRoute, express.raw({ type: 'application/json' }))

      app.post(webhookRoute, async (req, res) => {
        const sig = req.headers['stripe-signature']
        if (!sig || typeof sig !== 'string') {
          console.error('[Webhook] Missing stripe-signature header')
          return res.status(400).send({ error: 'Missing stripe-signature header' })
        }

        const rawBody = req.body
        if (!rawBody || !Buffer.isBuffer(rawBody)) {
          console.error('[Webhook] Body is not a Buffer!')
          return res.status(400).send({ error: 'Missing raw body for signature verification' })
        }

        try {
          await stripeSync!.processWebhook(rawBody, sig)
          return res.status(200).send({ received: true })
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error'
          console.error('[Webhook] Processing error:', errorMessage)
          return res.status(400).send({ error: errorMessage })
        }
      })

      app.use(express.json())
      app.use(express.urlencoded({ extended: false }))
      app.get('/health', async (req, res) => res.status(200).json({ status: 'ok' }))

      // Start Express server
      console.log(chalk.blue(`\nStarting server on port ${port}...`))
      await new Promise<void>((resolve, reject) => {
        server = app.listen(port, '0.0.0.0', () => resolve())
        server.on('error', reject)
      })
      console.log(chalk.green(`✓ Server started on port ${port}`))
    }

    // Run initial sync of all Stripe data (unless disabled)
    if (process.env.SKIP_BACKFILL !== 'true') {
      console.log(chalk.blue('\nStarting initial sync of all Stripe data...'))
      const syncResult = await stripeSync.processUntilDone()
      const totalSynced = Object.values(syncResult).reduce(
        (sum, result) => sum + (result?.synced || 0),
        0
      )
      console.log(chalk.green(`✓ Sync complete: ${totalSynced} objects synced`))
    } else {
      console.log(chalk.yellow('\n⏭️  Skipping initial sync (SKIP_BACKFILL=true)'))
    }

    console.log(
      chalk.cyan('\n● Streaming live changes...') + chalk.gray(' [press Ctrl-C to abort]')
    )

    // Keep the process alive
    await new Promise(() => {})
  } catch (error) {
    if (error instanceof Error) {
      console.error(chalk.red(error.message))
    }
    await cleanup()
    process.exit(1)
  }
}

/**
 * Parse a docker .env file and return key-value pairs
 */
function parseDockerEnv(envPath: string): Record<string, string> {
  const content = fs.readFileSync(envPath, 'utf-8')
  const result: Record<string, string> = {}

  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const eqIndex = trimmed.indexOf('=')
    if (eqIndex > 0) {
      const key = trimmed.substring(0, eqIndex)
      const value = trimmed.substring(eqIndex + 1)
      result[key] = value
    }
  }

  return result
}

/**
 * Install Edge Functions to local self-hosted Supabase Docker.
 * Copies function files to volumes/functions/<function-name>/index.ts
 * Also runs database migrations and sets up pg_cron worker job.
 */
async function installLocal(options: DeployOptions): Promise<void> {
  const dockerPath = options.dockerPath || './docker/supabase'
  const functionsPath = path.join(dockerPath, 'volumes', 'functions')

  // Verify docker path exists
  if (!fs.existsSync(dockerPath)) {
    throw new Error(
      `Docker Supabase directory not found at: ${dockerPath}\n` +
        `Please specify the correct path with --docker-path or run from the project root.`
    )
  }

  // Verify volumes/functions directory exists
  if (!fs.existsSync(functionsPath)) {
    throw new Error(
      `Functions directory not found at: ${functionsPath}\n` +
        `Make sure you have a self-hosted Supabase Docker setup.`
    )
  }

  // Get Stripe key for .env update
  let stripeKey =
    options.stripeKey || process.env.STRIPE_API_KEY || process.env.STRIPE_SECRET_KEY || ''

  if (!stripeKey) {
    const inquirer = (await import('inquirer')).default
    const answers = await inquirer.prompt([
      {
        type: 'password',
        name: 'stripeKey',
        message: 'Enter your Stripe secret key:',
        mask: '*',
        validate: (input: string) => {
          if (!input.trim()) return 'Stripe key is required'
          if (!input.startsWith('sk_') && !input.startsWith('rk_'))
            return 'Stripe key should start with "sk_" or "rk_"'
          return true
        },
      },
    ])
    stripeKey = answers.stripeKey
  }

  console.log(chalk.blue('\n🚀 Installing Stripe Sync to local Supabase Edge Functions...\n'))

  // Define function mappings
  const functions = [
    { name: 'stripe-setup', code: setupFunctionCode },
    { name: 'stripe-webhook', code: webhookFunctionCode },
    { name: 'stripe-worker', code: workerFunctionCode },
  ]

  // Copy each function to volumes/functions/<name>/index.ts
  for (const func of functions) {
    const funcDir = path.join(functionsPath, func.name)
    const funcFile = path.join(funcDir, 'index.ts')

    // Create function directory if it doesn't exist
    if (!fs.existsSync(funcDir)) {
      fs.mkdirSync(funcDir, { recursive: true })
      console.log(chalk.gray(`  Created directory: ${funcDir}`))
    }

    // Write the function code
    fs.writeFileSync(funcFile, func.code, 'utf-8')
    console.log(chalk.green(`  ✓ Deployed ${func.name}`))
  }

  // Check if STRIPE_SECRET_KEY is in the docker .env file
  const dockerEnvPath = path.join(dockerPath, '.env')
  let envUpdated = false

  if (fs.existsSync(dockerEnvPath)) {
    let envContent = fs.readFileSync(dockerEnvPath, 'utf-8')

    // Check if STRIPE_SECRET_KEY already exists
    if (envContent.includes('STRIPE_SECRET_KEY=')) {
      // Update existing value
      envContent = envContent.replace(/STRIPE_SECRET_KEY=.*$/m, `STRIPE_SECRET_KEY=${stripeKey}`)
      fs.writeFileSync(dockerEnvPath, envContent, 'utf-8')
      console.log(chalk.green(`  ✓ Updated STRIPE_SECRET_KEY in ${dockerEnvPath}`))
      envUpdated = true
    } else {
      // Append to end of file
      envContent = envContent.trimEnd() + `\n\n# Stripe Sync\nSTRIPE_SECRET_KEY=${stripeKey}\n`
      fs.writeFileSync(dockerEnvPath, envContent, 'utf-8')
      console.log(chalk.green(`  ✓ Added STRIPE_SECRET_KEY to ${dockerEnvPath}`))
      envUpdated = true
    }
  }

  // Ask if user wants to restart the functions service
  const inquirer = (await import('inquirer')).default
  const { shouldRestart } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'shouldRestart',
      message: 'Restart the functions service to pick up changes?',
      default: true,
    },
  ])

  if (shouldRestart) {
    console.log(chalk.blue('\n  Restarting functions service...'))

    await new Promise<void>((resolve) => {
      const dockerCompose = spawn('docker', ['compose', 'restart', 'functions', '--no-deps'], {
        cwd: dockerPath,
        stdio: 'inherit',
      })

      dockerCompose.on('close', (code) => {
        if (code === 0) {
          console.log(chalk.green('  ✓ Functions service restarted'))
          resolve()
        } else {
          console.log(chalk.yellow(`  ⚠ Failed to restart functions service (exit code: ${code})`))
          const restartCmd = `cd ${dockerPath} && docker compose restart functions --no-deps`
          console.log(chalk.gray(`  Run manually: ${restartCmd}`))
          resolve() // Don't reject, just warn
        }
      })

      dockerCompose.on('error', (err) => {
        console.log(chalk.yellow(`  ⚠ Failed to restart functions service: ${err.message}`))
        const restartCmd = `cd ${dockerPath} && docker compose restart functions --no-deps`
        console.log(chalk.gray(`  Run manually: ${restartCmd}`))
        resolve() // Don't reject, just warn
      })
    })
  } else {
    console.log(chalk.yellow(`\n  Remember to restart the functions service to pick up changes:`))
    console.log(chalk.gray(`  cd ${dockerPath} && docker compose restart functions --no-deps`))
  }

  // Run database setup (migrations + pg_cron)
  console.log(chalk.blue('\n  Setting up database...'))

  // Parse docker .env to get database credentials
  const dockerEnv = parseDockerEnv(dockerEnvPath)
  const dbPassword = dockerEnv.POSTGRES_PASSWORD
  const dbHost = 'localhost' // Connect from host machine
  const dbPort = '54322' // Default exposed port in docker-compose
  const dbName = dockerEnv.POSTGRES_DB || 'postgres'

  if (!dbPassword) {
    throw new Error('POSTGRES_PASSWORD not found in docker .env file')
  }

  const databaseUrl = `postgresql://postgres:${dbPassword}@${dbHost}:${dbPort}/${dbName}`

  try {
    // Run migrations
    console.log(chalk.gray('  Running database migrations...'))
    await runMigrations({ databaseUrl })
    console.log(chalk.green('  ✓ Database migrations complete'))

    // Set up pg_cron, pgmq, and vault secret
    console.log(chalk.gray('  Setting up pg_cron worker job...'))
    const { Pool } = await import('pg')
    const pool = new Pool({ connectionString: databaseUrl })

    try {
      // Generate worker secret
      const workerSecret = crypto.randomUUID()
      const escapedWorkerSecret = workerSecret.replace(/'/g, "''")

      // Calculate schedule (default 60 seconds)
      const intervalSeconds = options.workerInterval || 60
      let schedule: string
      if (intervalSeconds < 60) {
        schedule = `${intervalSeconds} seconds`
      } else if (intervalSeconds % 60 === 0 && intervalSeconds < 3600) {
        schedule = `*/${intervalSeconds / 60} * * * *`
      } else {
        schedule = '* * * * *' // Default to every minute
      }

      // Run pg_cron setup SQL
      // Note: For local Docker, the worker URL uses the internal Docker network
      const setupSql = `
        -- Enable extensions
        CREATE EXTENSION IF NOT EXISTS pg_cron;
        CREATE EXTENSION IF NOT EXISTS pg_net;
        CREATE EXTENSION IF NOT EXISTS pgmq;

        -- Create pgmq queue for sync work (idempotent)
        SELECT pgmq.create('stripe_sync_work')
        WHERE NOT EXISTS (
          SELECT 1 FROM pgmq.list_queues() WHERE queue_name = 'stripe_sync_work'
        );

        -- Store unique worker secret in vault for pg_cron to use
        DELETE FROM vault.secrets WHERE name = 'stripe_sync_worker_secret';
        SELECT vault.create_secret('${escapedWorkerSecret}', 'stripe_sync_worker_secret');

        -- Delete existing jobs if they exist
        SELECT cron.unschedule('stripe-sync-worker') WHERE EXISTS (
          SELECT 1 FROM cron.job WHERE jobname = 'stripe-sync-worker'
        );
        SELECT cron.unschedule('stripe-sync-scheduler') WHERE EXISTS (
          SELECT 1 FROM cron.job WHERE jobname = 'stripe-sync-scheduler'
        );

        -- Create job to invoke worker at configured interval
        -- Uses internal Docker network URL (kong:8000)
        SELECT cron.schedule(
          'stripe-sync-worker',
          '${schedule}',
          $$
          SELECT net.http_post(
            url := 'http://kong:8000/functions/v1/stripe-worker',
            headers := jsonb_build_object(
              'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'stripe_sync_worker_secret')
            )
          )
          $$
        );
      `

      await pool.query(setupSql)
      console.log(chalk.green('  ✓ pg_cron worker job configured'))
    } finally {
      await pool.end()
    }

    // Create Stripe webhook via ngrok tunnel if token available
    const ngrokToken = options.ngrokToken || process.env.NGROK_AUTH_TOKEN
    let webhookCreated = false
    let tunnel: NgrokTunnel | null = null

    if (ngrokToken) {
      console.log(chalk.gray('  Creating ngrok tunnel for webhook...'))
      try {
        // Create ngrok tunnel to local Supabase
        tunnel = await createTunnel(8000, ngrokToken)
        const webhookUrl = `${tunnel.url}/functions/v1/stripe-webhook`
        console.log(chalk.green(`  ✓ ngrok tunnel created: ${tunnel.url}`))

        // Create StripeSync instance to register webhook
        const stripeSync = new StripeSync({
          poolConfig: { connectionString: databaseUrl, max: 2 },
          stripeSecretKey: stripeKey,
        })

        try {
          console.log(chalk.gray('  Registering Stripe webhook...'))
          const webhook = await stripeSync.findOrCreateManagedWebhook(webhookUrl)
          console.log(chalk.green(`  ✓ Stripe webhook registered: ${webhook.id}`))
          webhookCreated = true
        } finally {
          await stripeSync.close()
        }
      } catch (ngrokError) {
        console.log(chalk.yellow(`  ⚠ ngrok/webhook setup failed: ${ngrokError instanceof Error ? ngrokError.message : String(ngrokError)}`))
        if (tunnel) {
          try {
            await tunnel.close()
          } catch {
            // Ignore cleanup errors
          }
          tunnel = null
        }
      }
    }

    if (!webhookCreated) {
      console.log(chalk.yellow('  ⚠ Stripe webhook not auto-created'))
      console.log(chalk.gray('    Provide --ngrok-token or NGROK_AUTH_TOKEN to auto-create webhook'))
      console.log(chalk.gray('    Or use Stripe CLI: stripe listen --forward-to localhost:8000/functions/v1/stripe-webhook'))
    }
  } catch (dbError) {
    console.log(chalk.yellow(`  ⚠ Database setup failed: ${dbError instanceof Error ? dbError.message : String(dbError)}`))
    console.log(chalk.gray('    Make sure your Supabase Docker is running and accessible at localhost:54322'))
  }

  // Print summary
  console.log(chalk.cyan('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'))
  console.log(chalk.cyan.bold('  Local Installation Complete!'))
  console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'))

  console.log(chalk.white('  Edge Functions installed:'))
  console.log(chalk.gray('    • stripe-setup   - Setup and status endpoint'))
  console.log(chalk.gray('    • stripe-webhook - Receives Stripe webhook events'))
  console.log(chalk.gray('    • stripe-worker  - Background sync worker'))

  console.log(chalk.white('\n  Database configured:'))
  console.log(chalk.gray('    • Migrations applied'))
  console.log(chalk.gray('    • pg_cron worker job scheduled'))
  console.log(chalk.gray('    • Vault secret configured'))

  console.log(chalk.white('\n  Next steps:'))
  console.log(chalk.gray('    1. View your data in Supabase Studio (localhost:8000) under the "stripe" schema'))
  console.log(chalk.gray('    2. If webhook not created, use Stripe CLI:'))
  console.log(chalk.gray('       stripe listen --forward-to localhost:8000/functions/v1/stripe-webhook'))

  if (!envUpdated) {
    console.log(chalk.yellow('\n  ⚠ Remember to add STRIPE_SECRET_KEY to your docker .env file!'))
  }
}

/**
 * Install command - installs Stripe sync Edge Functions to Supabase.
 * 1. Validates Supabase project access
 * 2. Deploys stripe-setup, stripe-webhook, and stripe-worker Edge Functions
 * 3. Sets required secrets (STRIPE_SECRET_KEY)
 * 4. Runs the setup function to create webhook and run migrations
 */
export async function installCommand(options: DeployOptions): Promise<void> {
  try {
    dotenv.config()

    // Handle local installation
    if (options.local) {
      await installLocal(options)
      return
    }

    let accessToken = options.supabaseAccessToken || process.env.SUPABASE_ACCESS_TOKEN || ''
    let projectRef = options.supabaseProjectRef || process.env.SUPABASE_PROJECT_REF || ''
    let stripeKey =
      options.stripeKey || process.env.STRIPE_API_KEY || process.env.STRIPE_SECRET_KEY || ''

    // Prompt for missing values
    if (!accessToken || !projectRef || !stripeKey) {
      const inquirer = (await import('inquirer')).default
      const questions = []

      if (!accessToken) {
        questions.push({
          type: 'password',
          name: 'accessToken',
          message: 'Enter your Supabase access token (from supabase.com/dashboard/account/tokens):',
          mask: '*',
          validate: (input: string) => input.trim() !== '' || 'Access token is required',
        })
      }

      if (!projectRef) {
        questions.push({
          type: 'input',
          name: 'projectRef',
          message: 'Enter your Supabase project ref (e.g., abcdefghijklmnop):',
          validate: (input: string) => input.trim() !== '' || 'Project ref is required',
        })
      }

      if (!stripeKey) {
        questions.push({
          type: 'password',
          name: 'stripeKey',
          message: 'Enter your Stripe secret key:',
          mask: '*',
          validate: (input: string) => {
            if (!input.trim()) return 'Stripe key is required'
            if (!input.startsWith('sk_') && !input.startsWith('rk_'))
              return 'Stripe key should start with "sk_" or "rk_"'
            return true
          },
        })
      }

      if (questions.length > 0) {
        console.log(chalk.yellow('\nMissing required configuration. Please provide:'))
        const answers = await inquirer.prompt(questions)
        if (answers.accessToken) accessToken = answers.accessToken
        if (answers.projectRef) projectRef = answers.projectRef
        if (answers.stripeKey) stripeKey = answers.stripeKey
      }
    }

    console.log(chalk.blue('\n🚀 Installing Stripe Sync to Supabase Edge Functions...\n'))

    // Get management URL from options or environment variable
    const supabaseManagementUrl =
      options.supabaseManagementUrl || process.env.SUPABASE_MANAGEMENT_URL

    // Run installation via the install() function
    console.log(chalk.gray('Validating project access...'))
    await install({
      supabaseAccessToken: accessToken,
      supabaseProjectRef: projectRef,
      stripeKey,
      packageVersion: options.packageVersion,
      workerIntervalSeconds: options.workerInterval,
      supabaseManagementUrl,
    })

    // Print summary
    console.log(chalk.cyan('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'))
    console.log(chalk.cyan.bold('  Installation Complete!'))
    console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'))
    console.log(chalk.gray('\n  Your Stripe data will stay in sync to your Supabase database.'))
    console.log(
      chalk.gray('  View your data in the Supabase dashboard under the "stripe" schema.\n')
    )
  } catch (error) {
    if (error instanceof Error) {
      console.error(chalk.red(`\n✗ Installation failed: ${error.message}`))
    }
    process.exit(1)
  }
}

/**
 * Uninstall command - removes Stripe sync Edge Functions and resources from Supabase.
 * 1. Validates Supabase project access
 * 2. Deletes Stripe webhooks
 * 3. Deletes Edge Functions (stripe-setup, stripe-webhook, stripe-worker)
 * 4. Deletes secrets and pg_cron jobs
 * 5. Drops the stripe schema
 */
export async function uninstallCommand(options: DeployOptions): Promise<void> {
  try {
    dotenv.config()

    let accessToken = options.supabaseAccessToken || process.env.SUPABASE_ACCESS_TOKEN || ''
    let projectRef = options.supabaseProjectRef || process.env.SUPABASE_PROJECT_REF || ''

    // Prompt for missing values
    if (!accessToken || !projectRef) {
      const inquirer = (await import('inquirer')).default
      const questions = []

      if (!accessToken) {
        questions.push({
          type: 'password',
          name: 'accessToken',
          message: 'Enter your Supabase access token (from supabase.com/dashboard/account/tokens):',
          mask: '*',
          validate: (input: string) => input.trim() !== '' || 'Access token is required',
        })
      }

      if (!projectRef) {
        questions.push({
          type: 'input',
          name: 'projectRef',
          message: 'Enter your Supabase project ref (e.g., abcdefghijklmnop):',
          validate: (input: string) => input.trim() !== '' || 'Project ref is required',
        })
      }

      if (questions.length > 0) {
        console.log(chalk.yellow('\nMissing required configuration. Please provide:'))
        const answers = await inquirer.prompt(questions)
        if (answers.accessToken) accessToken = answers.accessToken
        if (answers.projectRef) projectRef = answers.projectRef
      }
    }

    console.log(chalk.blue('\n🗑️  Uninstalling Stripe Sync from Supabase...\n'))
    console.log(chalk.yellow('⚠️  Warning: This will delete all Stripe data from your database!\n'))

    // Get management URL from options or environment variable
    const supabaseManagementUrl =
      options.supabaseManagementUrl || process.env.SUPABASE_MANAGEMENT_URL

    // Run uninstall via the uninstall() function
    console.log(chalk.gray('Removing all resources...'))
    await uninstall({
      supabaseAccessToken: accessToken,
      supabaseProjectRef: projectRef,
      supabaseManagementUrl,
    })

    // Print summary
    console.log(chalk.cyan('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'))
    console.log(chalk.cyan.bold('  Uninstall Complete!'))
    console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'))
    console.log(
      chalk.gray('\n  All Stripe sync resources have been removed from your Supabase project.')
    )
    console.log(chalk.gray('  - Edge Functions deleted'))
    console.log(chalk.gray('  - Stripe webhooks removed'))
    console.log(chalk.gray('  - Database schema dropped\n'))
  } catch (error) {
    if (error instanceof Error) {
      console.error(chalk.red(`\n✗ Uninstall failed: ${error.message}`))
    }
    process.exit(1)
  }
}
