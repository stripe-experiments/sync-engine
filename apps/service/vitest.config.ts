import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globalSetup: ['./vitest.global-setup.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.integration.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
