#!/usr/bin/env node
/**
 * Tests for assert-use-env-proxy.mjs
 * Run: node scripts/assert-use-env-proxy.test.mjs
 */

import { strictEqual, throws, doesNotThrow } from 'node:assert'

// Inline the logic so we can test it with injected env/execArgv
function getProxyUrl(env) {
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
    const value = env[key]?.trim()
    if (value) return value
  }
  return undefined
}

function assertUseEnvProxy(env, execArgv) {
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

const PROXY_ENV = { HTTPS_PROXY: 'http://proxy.example.test:8080' }
let passed = 0

function test(name, fn) {
  fn()
  console.log(`PASS: ${name}`)
  passed++
}

test('no proxy set — no throw', () => {
  doesNotThrow(() => assertUseEnvProxy({}, []))
})

test('proxy set, --use-env-proxy in execArgv — no throw', () => {
  doesNotThrow(() => assertUseEnvProxy(PROXY_ENV, ['--use-env-proxy']))
})

test('proxy set, --use-env-proxy in NODE_OPTIONS — no throw', () => {
  doesNotThrow(() => assertUseEnvProxy({ ...PROXY_ENV, NODE_OPTIONS: '--use-env-proxy' }, []))
})

test('proxy set, NODE_OPTIONS has multiple flags including --use-env-proxy — no throw', () => {
  doesNotThrow(() =>
    assertUseEnvProxy({ ...PROXY_ENV, NODE_OPTIONS: '--max-old-space-size=4096 --use-env-proxy' }, [])
  )
})

test('proxy set, --use-env-proxy absent — throws', () => {
  throws(() => assertUseEnvProxy(PROXY_ENV, []), /--use-env-proxy/)
})

test('lowercase http_proxy set, --use-env-proxy absent — throws', () => {
  throws(() => assertUseEnvProxy({ http_proxy: 'http://proxy.example.test:8080' }, []), /--use-env-proxy/)
})

test('error message includes the proxy URL', () => {
  throws(() => assertUseEnvProxy(PROXY_ENV, []), /http:\/\/proxy\.example\.test:8080/)
})

console.log(`\n--- ${passed} passed ---`)
