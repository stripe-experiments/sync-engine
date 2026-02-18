/// <reference types="vitest" />
import { defineConfig } from "vite";
import path from "node:path";
import fs from "node:fs";
import type { Plugin } from "vite";

/**
 * Vite plugin that mirrors the esbuild embeddedMigrationsPlugin from tsup.config.ts.
 * Resolves `?embedded` imports so tests can run without a build step.
 *
 * It's unfortunate to have to duplicate this logic twice but hopefully won't require changing often.
 */
function embeddedMigrationsPlugin(): Plugin {
  const EMBEDDED_RE = /\?embedded$/;
  const RESOLVED_PREFIX = "\0embedded-migrations:";

  return {
    name: "embedded-migrations",
    resolveId(source, importer) {
      if (!EMBEDDED_RE.test(source)) return null;
      const withoutQuery = source.replace(EMBEDDED_RE, "");
      const resolved = path.resolve(path.dirname(importer!), withoutQuery);
      return RESOLVED_PREFIX + resolved;
    },
    load(id) {
      if (!id.startsWith(RESOLVED_PREFIX)) return null;
      const migrationsDir = id.slice(RESOLVED_PREFIX.length);
      const files = fs
        .readdirSync(migrationsDir)
        .filter((f) => f.endsWith(".sql"))
        .sort();
      const migrations = files.map((filename) => ({
        name: filename,
        sql: fs.readFileSync(path.join(migrationsDir, filename), "utf-8"),
      }));
      return `export default ${JSON.stringify(migrations)};`;
    },
  };
}

export default defineConfig({
  plugins: [embeddedMigrationsPlugin()],
  test: {
    environment: "node",
    fileParallelism: false,
    testTimeout: 120000, // 2 minutes for integration tests
    hookTimeout: 60000, // 1 minute for setup/teardown
    deps: {
      inline: [/.*/],
    },
    // Exclude E2E tests from default `vitest` command
    // These require STRIPE_API_KEY and run separately via `test:e2e`
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "src/e2e-tests/*.e2e.test.ts",
    ],
  },
});
