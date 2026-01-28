import { build, type OnResolveArgs, type PluginBuild } from 'esbuild'
import { existsSync } from 'fs'
import { mkdir } from 'fs/promises'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const EDGE_FUNCTIONS = ['stripe-setup', 'stripe-webhook', 'stripe-worker', 'sigma-data-worker']

async function buildEdgeFunctions(): Promise<void> {
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = dirname(__filename)
  const packageRoot = resolve(__dirname, '..')
  const srcRoot = resolve(packageRoot, 'src')
  const outDir = resolve(packageRoot, 'dist', 'supabase', 'edge-functions')

  const syncEntry = resolve(srcRoot, 'index.ts')
  const syncEntryFallback = resolve(packageRoot, 'dist', 'index.js')
  const localSyncEntry = existsSync(syncEntry) ? syncEntry : syncEntryFallback

  if (!existsSync(localSyncEntry)) {
    throw new Error(`Local sync-engine entry not found at ${localSyncEntry}`)
  }

  const npmDeps = new Map([
    ['stripe', '^17.7.0'],
    ['pg', '^8.16.3'],
    ['pg-node-migrations', '0.0.8'],
    ['postgres', '^3.4.4'],
    ['yesql', '^7.0.0'],
    ['papaparse', '5.4.1'],
    ['ws', '^8.18.0'],
    ['dotenv', '^16.4.7'],
    ['express', '^4.18.2'],
    ['inquirer', '^12.3.0'],
  ])

  const resolverPlugin = {
    name: 'stripe-sync-local-resolver',
    setup: (buildApi: PluginBuild) => {
      buildApi.onResolve({ filter: /^stripe-experiment-sync$/ }, () => ({
        path: localSyncEntry,
      }))

      buildApi.onResolve({ filter: /^[^./].*/ }, (args: OnResolveArgs) => {
        const version = npmDeps.get(args.path)
        if (version) {
          return { path: `npm:${args.path}@${version}`, external: true }
        }
        return null
      })
    },
  }

  await mkdir(outDir, { recursive: true })

  for (const fn of EDGE_FUNCTIONS) {
    const entryPath = resolve(srcRoot, 'supabase', 'edge-functions', `${fn}.ts`)
    if (!existsSync(entryPath)) {
      throw new Error(`Edge function entry not found at ${entryPath}`)
    }

    await build({
      entryPoints: [entryPath],
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      target: 'es2020',
      outfile: resolve(outDir, `${fn}.js`),
      plugins: [resolverPlugin],
      external: ['node:*', 'crypto'],
      logLevel: 'info',
    })
  }

  console.log('✅ Edge functions built')
  console.log(`📦 Output: ${outDir}`)
}

buildEdgeFunctions().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
