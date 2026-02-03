/// <reference types="vitest" />
import { defineConfig } from 'vite'

// Separate config for CLI integration tests
// These tests require STRIPE_API_KEY and run via `test:integration:cli`
export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    testTimeout: 120000, // 2 minutes for integration tests
    hookTimeout: 60000, // 1 minute for setup/teardown
    deps: {
      inline: [/.*/],
    },
    include: ['src/integration/*.integration.test.ts'],
  },
})
