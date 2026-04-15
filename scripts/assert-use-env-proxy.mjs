#!/usr/bin/env node
/**
 * Assert that if HTTPS_PROXY/HTTP_PROXY is set, --use-env-proxy is also active.
 * Without it, Node's built-in fetch (undici) silently bypasses the proxy.
 *
 * Usage (fail fast at startup):
 *   node --import ./scripts/assert-use-env-proxy.mjs your-script.js
 *
 * Or run standalone to check the current environment:
 *   node scripts/assert-use-env-proxy.mjs
 */

function getProxyUrl(env = process.env) {
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
    const value = env[key]?.trim()
    if (value) return value
  }
  return undefined
}

function assertUseEnvProxy(env = process.env, execArgv = process.execArgv) {
  const proxyUrl = getProxyUrl(env)
  if (!proxyUrl) return

  const nodeOptions = (env.NODE_OPTIONS ?? '').split(/\s+/)
  const hasFlag =
    execArgv.includes('--use-env-proxy') || nodeOptions.includes('--use-env-proxy')

  if (!hasFlag) {
    throw new Error(
      `Proxy is configured (${proxyUrl}) but --use-env-proxy is not set.\n` +
        `Node's built-in fetch will bypass the proxy silently.\n` +
        `Fix: add --use-env-proxy to NODE_OPTIONS or pass it to node directly.`
    )
  }
}

assertUseEnvProxy()
