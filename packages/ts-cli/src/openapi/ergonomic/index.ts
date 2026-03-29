import { defineCommand } from 'citty'
import type { ArgDef, CommandDef } from 'citty'
import { buildRequest, handleResponse, toOptName } from '../dispatch.js'
import type { Handler } from '../dispatch.js'
import { defaultOperationName, parseSpec, toCliFlag } from '../parse.js'
import type { ParsedOperation } from '../parse.js'
import type { OpenAPIOperation, OpenAPISpec } from '../types.js'
import { decomposeHeaderParam } from './decompose.js'
import type { DecomposedParam } from './decompose.js'
import { assembleJsonHeader } from './assemble.js'

export type { Handler }
export { decomposeHeaderParam } from './decompose.js'
export { assembleJsonHeader } from './assemble.js'
export type { DecomposedFlag, DecomposedParam, FlagRole } from './decompose.js'
export type { AssembleContext } from './assemble.js'
export type { ExtendedSchema } from './types.js'
export { resolveRef, isJsonHeaderParam } from './types.js'

export interface CreateErgonomicCliOptions {
  /** OpenAPI 3.1 spec object */
  spec: OpenAPISpec
  /** Web-standard request handler */
  handler: Handler
  /** Override command name derivation */
  nameOperation?: (method: string, path: string, operation: OpenAPIOperation) => string
  /** Exclude specific operationIds */
  exclude?: string[]
  /** Group commands under subcommands by OpenAPI tag */
  groupByTag?: boolean
  /** Base URL for constructing Request objects (default: 'http://localhost') */
  baseUrl?: string
  /** Provider for NDJSON request body stream */
  ndjsonBodyStream?: () => ReadableStream | null | undefined
  /** CLI metadata for the root command */
  meta?: { name?: string; description?: string; version?: string }
  /** Extra args to declare on the root command */
  rootArgs?: Record<string, ArgDef>
  /** Map of schema property names to env var prefixes.
   *  e.g. { source: 'SOURCE', destination: 'DESTINATION' } */
  envPrefixes?: Record<string, string>
}

/** Returns a citty CommandDef with ergonomic, decomposed flags for JSON-in-header params. */
export function createErgonomicCli(opts: CreateErgonomicCliOptions): CommandDef {
  const {
    spec,
    handler,
    nameOperation,
    exclude = [],
    groupByTag = false,
    baseUrl = 'http://localhost',
    ndjsonBodyStream,
    meta,
    rootArgs,
    envPrefixes = {},
  } = opts

  const operations = parseSpec(spec).filter(
    (op) => !op.operationId || !exclude.includes(op.operationId)
  )

  const subCommands: Record<string, CommandDef> = {}

  if (groupByTag) {
    const groups = new Map<string, ParsedOperation[]>()
    const ungrouped: ParsedOperation[] = []

    for (const op of operations) {
      const tag = op.tags[0]
      if (tag) {
        const list = groups.get(tag) ?? []
        list.push(op)
        groups.set(tag, list)
      } else {
        ungrouped.push(op)
      }
    }

    for (const [tag, ops] of groups) {
      const groupSubCommands: Record<string, CommandDef> = {}
      for (const op of ops) {
        const name = getOpName(op, nameOperation)
        groupSubCommands[name] = buildErgonomicCommand(
          op,
          spec,
          handler,
          baseUrl,
          nameOperation,
          ndjsonBodyStream,
          envPrefixes
        )
      }
      subCommands[toCliFlag(tag)] = defineCommand({
        meta: { name: toCliFlag(tag) },
        subCommands: groupSubCommands,
      })
    }

    for (const op of ungrouped) {
      const name = getOpName(op, nameOperation)
      subCommands[name] = buildErgonomicCommand(
        op,
        spec,
        handler,
        baseUrl,
        nameOperation,
        ndjsonBodyStream,
        envPrefixes
      )
    }
  } else {
    for (const op of operations) {
      const name = getOpName(op, nameOperation)
      subCommands[name] = buildErgonomicCommand(
        op,
        spec,
        handler,
        baseUrl,
        nameOperation,
        ndjsonBodyStream,
        envPrefixes
      )
    }
  }

  return defineCommand({
    meta: meta
      ? { name: meta.name, description: meta.description, version: meta.version }
      : undefined,
    args: rootArgs,
    subCommands,
  })
}

function getOpName(
  op: ParsedOperation,
  nameOverride?: (method: string, path: string, op: OpenAPIOperation) => string
): string {
  const rawOp = toRawOp(op)
  return nameOverride
    ? nameOverride(op.method, op.path, rawOp)
    : defaultOperationName(op.method, op.path, rawOp)
}

function toRawOp(op: ParsedOperation): OpenAPIOperation {
  return {
    operationId: op.operationId,
    tags: op.tags,
    parameters: [...op.pathParams, ...op.queryParams, ...op.headerParams],
    requestBody: op.bodySchema
      ? {
          required: op.bodyRequired,
          content: { 'application/json': { schema: op.bodySchema } },
        }
      : undefined,
  }
}

/** Build a single ergonomic command, decomposing JSON-in-header params. */
function buildErgonomicCommand(
  operation: ParsedOperation,
  spec: OpenAPISpec,
  handler: Handler,
  baseUrl: string,
  nameOverride: CreateErgonomicCliOptions['nameOperation'],
  ndjsonBodyStream: CreateErgonomicCliOptions['ndjsonBodyStream'],
  envPrefixes: Record<string, string>
): CommandDef {
  const rawOp = toRawOp(operation)
  const name = nameOverride
    ? nameOverride(operation.method, operation.path, rawOp)
    : defaultOperationName(operation.method, operation.path, rawOp)

  const args: Record<string, ArgDef> = {}

  // Path params → positional args
  for (const param of operation.pathParams) {
    args[param.name] = {
      type: 'positional',
      required: param.required !== false,
      description: param.description ?? '',
    }
  }

  // Query params → --flags
  for (const param of operation.queryParams) {
    const key = toOptName(param.name)
    args[key] = {
      type: 'string',
      required: param.required === true,
      description: param.description ?? '',
    }
  }

  // Header params: decompose JSON headers, pass through non-JSON
  const decomposed: DecomposedParam[] = []
  for (const param of operation.headerParams) {
    const dp = decomposeHeaderParam(param, spec)
    decomposed.push(dp)
    for (const flag of dp.flags) {
      args[flag.name] = {
        type: flag.type,
        required: false, // Ergonomic flags are never individually required by citty
        description: flag.description,
      }
    }
  }

  // Body: same logic as original command.ts
  if (operation.bodySchema) {
    const props = operation.bodySchema.properties
    if (props && !operation.ndjsonRequest) {
      const requiredFields = operation.bodySchema.required ?? []
      for (const [propName, propSchema] of Object.entries(props)) {
        const key = toOptName(propName)
        args[key] = {
          type: 'string',
          required: requiredFields.includes(propName),
          description: propSchema.description ?? '',
        }
      }
    } else {
      const bodyOptional = operation.ndjsonRequest && ndjsonBodyStream !== undefined
      args['body'] = {
        type: 'string',
        required: operation.bodyRequired === true && !bodyOptional,
        description: 'Request body as JSON string',
      }
    }
  }

  return defineCommand({
    meta: { name },
    args,
    async run({ args: cmdArgs }) {
      const positionals = operation.pathParams.map(
        (p) => (cmdArgs as Record<string, string>)[p.name]
      )
      const opts = cmdArgs as Record<string, string | undefined>

      // Build the base request using buildRequest for path/query/body handling.
      // We pass an operation with empty headerParams so buildRequest doesn't set raw headers.
      const opForBuild: ParsedOperation = {
        ...operation,
        headerParams: [],
      }
      let request = buildRequest(opForBuild, positionals, opts, baseUrl)

      // Assemble JSON headers from decomposed flags
      const headers = new Headers(request.headers)
      for (const dp of decomposed) {
        if (dp.isJsonHeader) {
          const value = assembleJsonHeader({
            flags: dp.flags,
            args: opts,
            envPrefixes,
          })
          if (value) {
            headers.set(dp.headerName, value)
          }
        } else {
          // Non-JSON header: get value from the single flag
          const flag = dp.flags[0]
          if (flag) {
            const value = opts[flag.name]
            if (value !== undefined) {
              headers.set(dp.headerName, value)
            }
          }
        }
      }

      request = new Request(request.url, {
        method: request.method,
        headers,
        body: request.body,
        ...(request.body ? { duplex: 'half' } : {}),
      } as RequestInit)

      // Handle NDJSON body stream override
      if (operation.ndjsonRequest && ndjsonBodyStream) {
        const stream = ndjsonBodyStream()
        if (stream) {
          const ndjsonHeaders = new Headers(request.headers)
          ndjsonHeaders.set('Content-Type', 'application/x-ndjson')
          ndjsonHeaders.set('Transfer-Encoding', 'chunked')
          request = new Request(request.url, {
            method: request.method,
            headers: ndjsonHeaders,
            body: stream,
            duplex: 'half',
          } as RequestInit)
        }
      }

      const response = await handler(request)
      await handleResponse(response, operation)
    },
  })
}
