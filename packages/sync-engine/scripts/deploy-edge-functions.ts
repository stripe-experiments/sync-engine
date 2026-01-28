import dotenv from 'dotenv'
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { SupabaseManagementAPI } from 'supabase-management-js'

const EDGE_FUNCTIONS = ['stripe-setup', 'stripe-webhook', 'stripe-worker', 'sigma-data-worker']

function isResponse(value: unknown): value is Response {
  return typeof Response !== 'undefined' && value instanceof Response
}

async function formatSupabaseError(error: unknown): Promise<string | null> {
  if (isResponse(error)) {
    const body = error.bodyUsed ? '' : await error.text().catch(() => '')
    const details = body ? ` - ${body}` : ''
    return `Supabase Management API request failed (${error.status} ${error.statusText})${details}`
  }

  if (error && typeof error === 'object' && 'response' in error) {
    const response = (error as { response?: unknown }).response
    if (isResponse(response)) {
      const body = response.bodyUsed ? '' : await response.text().catch(() => '')
      const details = body ? ` - ${body}` : ''
      return `Supabase Management API request failed (${response.status} ${response.statusText})${details}`
    }
  }

  return null
}

async function deployEdgeFunctions(): Promise<void> {
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = dirname(__filename)
  const packageRoot = resolve(__dirname, '..')
  const repoRoot = resolve(packageRoot, '../..')
  const buildDir = resolve(packageRoot, 'dist', 'supabase', 'edge-functions')

  dotenv.config({ path: resolve(repoRoot, '.env') })
  dotenv.config({ path: resolve(packageRoot, '.env'), override: true })

  const accessToken = process.env.SUPABASE_ACCESS_TOKEN?.trim()
  const projectRef = process.env.SUPABASE_PROJECT_REF?.trim()

  if (!accessToken) {
    throw new Error('SUPABASE_ACCESS_TOKEN is required (set in .env or env var)')
  }

  if (!projectRef) {
    throw new Error('SUPABASE_PROJECT_REF is required (set in .env or env var)')
  }

  if (!existsSync(buildDir)) {
    throw new Error(
      `Build output not found at ${buildDir}. Run "pnpm --filter stripe-experiment-sync build:edge-functions" first.`
    )
  }

  const api = new SupabaseManagementAPI({
    accessToken,
  })

  const existingFunctions = await api.listFunctions(projectRef)
  const existingSlugs = new Set((existingFunctions || []).map((fn) => fn.slug))

  for (const fn of EDGE_FUNCTIONS) {
    const filePath = resolve(buildDir, `${fn}.js`)
    if (!existsSync(filePath)) {
      throw new Error(`Missing build output for ${fn} at ${filePath}`)
    }

    const code = await readFile(filePath, 'utf8')

    if (existingSlugs.has(fn)) {
      await api.updateFunction(projectRef, fn, { body: code, verify_jwt: false })
      console.log(`🔁 Updated edge function: ${fn}`)
    } else {
      await api.createFunction(projectRef, {
        slug: fn,
        name: fn,
        body: code,
        verify_jwt: false,
      })
      console.log(`✅ Created edge function: ${fn}`)
    }
  }

  console.log('✅ Edge functions deployed via Management API')
}

deployEdgeFunctions().catch(async (error) => {
  const message = await formatSupabaseError(error)
  if (message) {
    console.error(message)
    console.error(
      'Check that SUPABASE_ACCESS_TOKEN is a Supabase personal access token with access to this project.'
    )
  } else {
    console.error(error)
  }
  process.exitCode = 1
})
