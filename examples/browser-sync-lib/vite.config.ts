import { defineConfig, type Plugin } from 'vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const shim = (name: string) => path.resolve(__dirname, `src/shims/${name}.ts`)

function nodeShimPlugin(): Plugin {
  const polyfillsRoot = path.resolve(__dirname, 'node_modules/vite-plugin-node-polyfills')
  const polyfillShim = (name: string) =>
    path.join(polyfillsRoot, 'shims', name, 'dist/index.js')

  const shims: Record<string, string> = {
    'node:child_process': shim('child_process'),
    'node:fs': shim('node-builtins'),
    'node:fs/promises': shim('node-builtins'),
    'node:net': shim('noop'),
    'node:http': shim('noop'),
    'node:url': shim('url'),
    'vite-plugin-node-polyfills/shims/buffer': polyfillShim('buffer'),
    'vite-plugin-node-polyfills/shims/process': polyfillShim('process'),
    'vite-plugin-node-polyfills/shims/global': polyfillShim('global'),
  }

  return {
    name: 'node-shim-resolver',
    enforce: 'pre',
    resolveId(source) {
      if (shims[source]) return shims[source]
      return null
    },
  }
}

export default defineConfig({
  plugins: [
    nodeShimPlugin(),
    nodePolyfills({
      include: ['buffer', 'crypto', 'stream', 'path', 'os', 'events', 'util', 'process'],
      globals: { process: true, Buffer: true, global: true },
    }),
  ],
  resolve: {
    alias: {
      '@stripe/sync-logger/progress': shim('logger-progress'),
      '@stripe/sync-logger': shim('logger'),
      'pg': shim('pg'),
      'ws': shim('ws'),
      'https-proxy-agent': shim('noop'),
    },
  },
  define: {
    'process.platform': '"browser"',
    'process.env.NODE_DEBUG': '""',
    'process.env.NODE_ENV': '"production"',
  },
  build: {
    target: 'esnext',
    lib: {
      entry: path.resolve(__dirname, 'src/index.ts'),
      formats: ['es'],
      fileName: () => 'index.js',
    },
    rollupOptions: {
      external: ['@electric-sql/pglite'],
      output: {
        inlineDynamicImports: true,
      },
    },
    sourcemap: true,
    emptyOutDir: true,
  },
  optimizeDeps: {
    exclude: ['@electric-sql/pglite'],
    esbuildOptions: { target: 'esnext' },
  },
})
