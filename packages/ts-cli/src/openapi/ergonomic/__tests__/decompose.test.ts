import { describe, expect, it } from 'vitest'
import type { OpenAPIParameter, OpenAPISpec } from '../../types.js'
import { decomposeHeaderParam } from '../decompose.js'

const pipelineSpec: OpenAPISpec = {
  paths: {},
  components: {
    schemas: {
      PipelineConfig: {
        type: 'object',
        required: ['source', 'destination'],
        properties: {
          source: {
            type: 'object',
            required: ['name'],
            properties: { name: { type: 'string' } },
            additionalProperties: true,
          },
          destination: {
            type: 'object',
            required: ['name'],
            properties: { name: { type: 'string' } },
            additionalProperties: true,
          },
          streams: {
            type: 'array',
            items: {
              type: 'object',
              required: ['name'],
              properties: { name: { type: 'string' } },
            },
          },
        },
      },
    },
  },
}

describe('decomposeHeaderParam', () => {
  it('decomposes a JSON header with $ref to PipelineConfig', () => {
    const param: OpenAPIParameter = {
      name: 'x-pipeline',
      in: 'header',
      schema: {
        type: 'string',
        contentMediaType: 'application/json',
        contentSchema: { $ref: '#/components/schemas/PipelineConfig' },
      } as never,
    }

    const result = decomposeHeaderParam(param, pipelineSpec)

    expect(result.headerName).toBe('x-pipeline')
    expect(result.isJsonHeader).toBe(true)

    const flagNames = result.flags.map((f) => f.cliFlag)
    expect(flagNames).toContain('--source')
    expect(flagNames).toContain('--source-config')
    expect(flagNames).toContain('--destination')
    expect(flagNames).toContain('--destination-config')
    expect(flagNames).toContain('--streams')
    expect(flagNames).toContain('--config')
  })

  it('assigns correct roles to PipelineConfig flags', () => {
    const param: OpenAPIParameter = {
      name: 'x-pipeline',
      in: 'header',
      schema: {
        type: 'string',
        contentMediaType: 'application/json',
        contentSchema: { $ref: '#/components/schemas/PipelineConfig' },
      } as never,
    }

    const result = decomposeHeaderParam(param, pipelineSpec)
    const byCliFlag = new Map(result.flags.map((f) => [f.cliFlag, f]))

    expect(byCliFlag.get('--source')!.role).toBe('name')
    expect(byCliFlag.get('--source-config')!.role).toBe('config')
    expect(byCliFlag.get('--destination')!.role).toBe('name')
    expect(byCliFlag.get('--destination-config')!.role).toBe('config')
    expect(byCliFlag.get('--streams')!.role).toBe('list')
    expect(byCliFlag.get('--config')!.role).toBe('base-config')
  })

  it('sets parentProp for name and config flags', () => {
    const param: OpenAPIParameter = {
      name: 'x-pipeline',
      in: 'header',
      schema: {
        type: 'string',
        contentMediaType: 'application/json',
        contentSchema: { $ref: '#/components/schemas/PipelineConfig' },
      } as never,
    }

    const result = decomposeHeaderParam(param, pipelineSpec)
    const sourceFlag = result.flags.find((f) => f.cliFlag === '--source')!
    const sourceConfigFlag = result.flags.find((f) => f.cliFlag === '--source-config')!

    expect(sourceFlag.parentProp).toBe('source')
    expect(sourceFlag.path).toEqual(['source', 'name'])
    expect(sourceConfigFlag.parentProp).toBe('source')
    expect(sourceConfigFlag.path).toEqual(['source'])
  })

  it('handles non-JSON header param (integer)', () => {
    const param: OpenAPIParameter = {
      name: 'x-state-checkpoint-limit',
      in: 'header',
      schema: { type: 'integer' },
      description: 'Stop after N checkpoints',
    }

    const result = decomposeHeaderParam(param, pipelineSpec)

    expect(result.isJsonHeader).toBe(false)
    expect(result.flags).toHaveLength(1)
    expect(result.flags[0]!.cliFlag).toBe('--state-checkpoint-limit')
    expect(result.flags[0]!.role).toBe('scalar')
    expect(result.flags[0]!.description).toBe('Stop after N checkpoints')
  })

  it('handles non-JSON header param with JSON content (x-state with no contentSchema)', () => {
    const param: OpenAPIParameter = {
      name: 'x-state',
      in: 'header',
      schema: { type: 'string' },
      description: 'Per-stream cursor state',
    }

    const result = decomposeHeaderParam(param, pipelineSpec)

    expect(result.isJsonHeader).toBe(false)
    expect(result.flags).toHaveLength(1)
    expect(result.flags[0]!.cliFlag).toBe('--state')
    expect(result.flags[0]!.role).toBe('json')
  })

  it('handles JSON header with inline schema (open object)', () => {
    const param: OpenAPIParameter = {
      name: 'x-state',
      in: 'header',
      schema: {
        type: 'string',
        contentMediaType: 'application/json',
        contentSchema: {
          type: 'object',
          additionalProperties: true,
          description: 'Per-stream cursor state',
        },
      } as never,
    }

    const result = decomposeHeaderParam(param, pipelineSpec)

    expect(result.isJsonHeader).toBe(true)
    // Open object with no properties → only a base-config flag
    const configFlag = result.flags.find((f) => f.role === 'base-config')
    expect(configFlag).toBeDefined()
  })

  it('marks source as required when schema says so', () => {
    const param: OpenAPIParameter = {
      name: 'x-pipeline',
      in: 'header',
      schema: {
        type: 'string',
        contentMediaType: 'application/json',
        contentSchema: { $ref: '#/components/schemas/PipelineConfig' },
      } as never,
    }

    const result = decomposeHeaderParam(param, pipelineSpec)
    const sourceFlag = result.flags.find((f) => f.cliFlag === '--source')!
    const streamsFlag = result.flags.find((f) => f.cliFlag === '--streams')!

    // source is in required: ['source', 'destination']
    expect(sourceFlag.required).toBe(true)
    // streams is not in required
    expect(streamsFlag.required).toBe(false)
  })
})
