/**
 * Vitest global setup: starts ONE Temporal dev server for the entire test run.
 *
 * Each test file connects to this shared server via TestWorkflowEnvironment.createFromExistingServer()
 * rather than calling createLocal() per-file, which avoids concurrent startup races under
 * Vitest's default file parallelism.
 */
import { TestWorkflowEnvironment } from '@temporalio/testing'
import type { GlobalSetupContext } from 'vitest/node'

let env: TestWorkflowEnvironment | undefined

export async function setup({ provide }: GlobalSetupContext) {
  env = await TestWorkflowEnvironment.createLocal()
  provide('temporalTestServerAddress', env.address)
}

export async function teardown() {
  await env?.teardown()
}
