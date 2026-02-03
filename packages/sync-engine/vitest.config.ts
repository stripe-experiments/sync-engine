/// <reference types="vitest" />
import { defineConfig } from 'vite'

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    testTimeout: 120000, // 2 minutes for integration tests
    hookTimeout: 60000, // 1 minute for setup/teardown
    deps: {
      inline: [/.*/],
    },
    // Exclude CLI integration tests from default `vitest` command
    // These require STRIPE_API_KEY and run separately via `test:integration:cli`
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'src/integration/*.integration.test.ts',
    ],
  },
})
