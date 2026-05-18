import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

try {
  // Read expected version directly from pnpm-lock.yaml
  const lockStr = readFileSync(new URL('../pnpm-lock.yaml', import.meta.url), 'utf8')

  // Look for the exact resolved version of Prettier in the lockfile
  const lockMatch = lockStr.match(/(?:^|\n)\s*prettier@(\d+\.\d+\.\d+):/)

  if (!lockMatch) {
    throw new Error('Prettier version not found in pnpm-lock.yaml')
  }

  const expectedVersion = lockMatch[1]

  // Get currently active version (this works because it's run from an npm script so prettier is in PATH)
  const installedVersion = execSync('prettier --version', { encoding: 'utf8' }).trim()

  if (installedVersion !== expectedVersion) {
    console.error(
      `\x1b[31m❌ ERROR: Installed Prettier version (${installedVersion}) does not match the expected locked version in pnpm-lock.yaml (${expectedVersion}).\x1b[0m`
    )
    console.error(
      `\x1b[31m   Please run 'pnpm install' to sync your local environment with CI and prevent formatting drift.\x1b[0m\n`
    )
    process.exit(1)
  }
} catch (error) {
  // Silently ignore errors (like missing dependencies) so we don't break the formatting workflow
}
