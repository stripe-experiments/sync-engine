import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { crx } from '@crxjs/vite-plugin'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import path from 'path'
import { fileURLToPath } from 'url'
import manifest from './manifest.config'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const browserSyncShim = (name: string) =>
  path.resolve(__dirname, `../browser-sync/src/shims/${name}.ts`)

const polyfillShimPath = (subpath: string) =>
  path.resolve(__dirname, 'node_modules/vite-plugin-node-polyfills/shims', subpath, 'dist/index.js')

const localShim = (name: string) => path.resolve(__dirname, `src/shims/${name}.ts`)

function nodeShimPlugin(): Plugin {
  const nodeShims: Record<string, string> = {
    'node:child_process': browserSyncShim('child_process'),
    'node:fs': browserSyncShim('node-builtins'),
    'node:fs/promises': browserSyncShim('node-builtins'),
    'node:net': browserSyncShim('noop'),
    'node:http': browserSyncShim('noop'),
    'node:url': browserSyncShim('url'),
    'node:stream/promises': localShim('stream-promises'),
    'stream/promises': localShim('stream-promises'),
    'stream-browserify/promises': localShim('stream-promises'),
  }
  const polyfillPrefix = 'vite-plugin-node-polyfills/shims/'
  const openapiSpecShim = localShim('openapi-spec')
  return {
    name: 'node-shim-resolver',
    enforce: 'pre',
    async resolveId(source, importer) {
      if (nodeShims[source]) return nodeShims[source]
      if (source.startsWith(polyfillPrefix)) {
        const sub = source.slice(polyfillPrefix.length)
        return polyfillShimPath(sub)
      }
      if (source.endsWith('stream-browserify/promises')) {
        return localShim('stream-promises')
      }
      // Redirect openapi's specFetchHelper (which uses node:fs/url at runtime)
      // to a browser-friendly shim that returns the bundled OAS via Vite's JSON loader.
      if (
        /packages\/openapi\/(dist\/specFetchHelper\.js|specFetchHelper\.ts)$/.test(source) ||
        (source === './specFetchHelper.js' &&
          importer &&
          /packages\/openapi\/(dist|index\.ts)/.test(importer))
      ) {
        return openapiSpecShim
      }
      return null
    },
  }
}

export default defineConfig({
  plugins: [
    nodeShimPlugin(),
    react(),
    nodePolyfills({
      include: ['buffer', 'crypto', 'stream', 'path', 'os', 'events', 'util', 'process'],
      globals: { process: true, Buffer: true, global: true },
    }),
    crx({ manifest }),
  ],
  resolve: {
    alias: {
      '@stripe/sync-logger/progress': browserSyncShim('logger-progress'),
      '@stripe/sync-logger': browserSyncShim('logger'),
      pg: browserSyncShim('pg'),
      ws: browserSyncShim('ws'),
      'https-proxy-agent': browserSyncShim('noop'),
    },
  },
  define: {
    'process.platform': '"browser"',
    'process.env.NODE_DEBUG': '""',
    'process.env.NODE_ENV': '"development"',
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      input: {
        sidepanel: path.resolve(__dirname, 'src/sidepanel/index.html'),
        options: path.resolve(__dirname, 'src/options/index.html'),
        offscreen: path.resolve(__dirname, 'src/offscreen.html'),
      },
    },
  },
  optimizeDeps: {
    exclude: ['@electric-sql/pglite'],
    esbuildOptions: { target: 'esnext' },
  },
})
