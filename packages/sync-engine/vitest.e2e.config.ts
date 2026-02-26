/// <reference types="vitest" />
import { defineConfig } from 'vite'

// Separate config for E2E tests
// These tests require STRIPE_API_KEY and run via `test:e2e`
export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    testTimeout: 120000, // 2 minutes for E2E tests
    hookTimeout: 60000, // 1 minute for setup/teardown
    deps: {
      inline: [/.*/],
    },
    include: ['src/tests/e2e/*.e2e.test.ts'],
  },
})
