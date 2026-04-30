import { describe, expect, it } from 'vitest'
import { parseStreamCsv, runStartWizard, type StartPromptIO } from '../cli/start.js'

function progress() {
  return {
    started_at: new Date().toISOString(),
    elapsed_ms: 1,
    global_state_count: 0,
    derived: {
      status: 'completed',
      records_per_second: 0,
      states_per_second: 0,
      total_record_count: 0,
      total_state_count: 0,
    },
    streams: {},
  }
}

function scriptedIO(answers: string[]): StartPromptIO & { output: string[] } {
  const output: string[] = []
  return {
    isTTY: true,
    output,
    write(message: string) {
      output.push(message)
    },
    async question(prompt: string) {
      output.push(prompt)
      const next = answers.shift()
      if (next === undefined) throw new Error(`No scripted answer for prompt: ${prompt}`)
      return next
    },
  }
}

describe('start cli', () => {
  it('parses stream CSV with trimming and dedupe', () => {
    expect(parseStreamCsv(' customers, prices,,customers , products ')).toEqual([
      'customers',
      'prices',
      'products',
    ])
  })

  it('builds and runs a generic pipeline from interactive answers', async () => {
    const pipelines: unknown[] = []
    const engine = {
      async meta_sources_list() {
        return {
          items: [
            {
              type: 'metronome',
              config_schema: {
                type: 'object',
                required: ['api_key'],
                properties: {
                  api_key: { type: 'string' },
                  backfill_limit: { type: 'integer' },
                },
              },
            },
          ],
        }
      },
      async meta_destinations_list() {
        return {
          items: [
            {
              type: 'redis',
              config_schema: {
                type: 'object',
                properties: {
                  url: { type: 'string' },
                  key_prefix: { type: 'string' },
                },
              },
            },
          ],
        }
      },
      async *source_discover() {
        yield {
          type: 'catalog',
          catalog: {
            streams: [
              {
                name: 'net_balance',
                primary_key: [['customer_id']],
                newer_than_field: '_synced_at',
                json_schema: {},
              },
            ],
          },
        }
      },
      async *pipeline_check(pipeline: unknown) {
        pipelines.push(pipeline)
        yield {
          type: 'connection_status',
          _emitted_by: 'source/metronome',
          connection_status: { status: 'succeeded' },
        }
        yield {
          type: 'connection_status',
          _emitted_by: 'destination/redis',
          connection_status: { status: 'succeeded' },
        }
      },
      async *pipeline_setup(pipeline: unknown) {
        pipelines.push(pipeline)
      },
      async *pipeline_sync(pipeline: unknown) {
        pipelines.push(pipeline)
        yield {
          type: 'eof',
          eof: { run_progress: progress() },
        }
      },
    }

    const io = scriptedIO([
      'test-token',
      'n',
      'y',
      'redis://127.0.0.1:56379',
      'demo:',
      'missing',
      'net_balance',
    ])

    await runStartWizard(engine as never, io, { plain: true })

    expect(pipelines.at(-1)).toEqual({
      source: { type: 'metronome', metronome: { api_key: 'test-token' } },
      destination: {
        type: 'redis',
        redis: { url: 'redis://127.0.0.1:56379', key_prefix: 'demo:' },
      },
      streams: [{ name: 'net_balance' }],
    })
    expect(io.output.join('')).toContain('Unknown stream(s): missing')
  })
})
