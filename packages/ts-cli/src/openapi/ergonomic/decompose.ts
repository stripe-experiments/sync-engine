import type { OpenAPIParameter, OpenAPISpec } from '../types.js'
import { toCliFlag } from '../parse.js'
import { toOptName } from '../dispatch.js'
import type { ExtendedSchema } from './types.js'
import { isJsonHeaderParam, resolveRef } from './types.js'

export type FlagRole =
  | 'name' // shorthand for obj.name: --source stripe
  | 'config' // JSON/file for rest of object: --source-config '{...}'
  | 'list' // comma-separated names: --streams a,b
  | 'json' // full JSON/file: --state '{...}'
  | 'scalar' // plain value: --state-checkpoint-limit 5
  | 'base-config' // entire parent object: --config pipeline.json

export interface DecomposedFlag {
  /** citty arg key (camelCase): "source", "sourceConfig", "streams" */
  name: string
  /** Display flag: "--source", "--source-config", "--streams" */
  cliFlag: string
  type: 'string' | 'boolean'
  required: boolean
  description: string
  role: FlagRole
  /** JSON path this flag maps to in the parent object */
  path: string[]
  /** For 'name'/'config' roles: the property name on the parent object */
  parentProp?: string
}

export interface DecomposedParam {
  /** Original header name (e.g. "x-pipeline") */
  headerName: string
  /** Whether this header has JSON content */
  isJsonHeader: boolean
  /** Generated flags from decomposing the content schema */
  flags: DecomposedFlag[]
}

/** Decompose a single header parameter into ergonomic CLI flags. */
export function decomposeHeaderParam(
  param: OpenAPIParameter,
  spec: OpenAPISpec,
): DecomposedParam {
  if (!isJsonHeaderParam(param)) {
    // Non-JSON header: single flag, strip x- prefix
    const flagCliName = stripXPrefix(param.name)
    const schema = param.schema as ExtendedSchema | undefined
    const isInteger = schema?.type === 'integer' || schema?.type === 'number'
    return {
      headerName: param.name,
      isJsonHeader: false,
      flags: [
        {
          name: toOptName(flagCliName),
          cliFlag: '--' + toCliFlag(flagCliName),
          type: 'string',
          required: param.required === true,
          description: param.description ?? schema?.description ?? '',
          role: isInteger ? 'scalar' : 'json',
          path: [],
        },
      ],
    }
  }

  const schema = param.schema as ExtendedSchema
  let contentSchema = schema.contentSchema!
  if (contentSchema.$ref) {
    contentSchema = resolveRef(spec, contentSchema.$ref)
  }

  const flags = decomposeSchema(contentSchema, param)
  return {
    headerName: param.name,
    isJsonHeader: true,
    flags,
  }
}

/** Decompose a resolved content schema into individual CLI flags. */
function decomposeSchema(
  schema: ExtendedSchema,
  param: OpenAPIParameter,
): DecomposedFlag[] {
  const flags: DecomposedFlag[] = []
  const requiredProps = schema.required ?? []

  for (const [propName, propSchema] of Object.entries(schema.properties ?? {})) {
    const resolved = propSchema as ExtendedSchema

    if (isNamedObject(resolved)) {
      // Object with properties.name + additionalProperties → two flags: name + config
      flags.push({
        name: toOptName(propName),
        cliFlag: '--' + toCliFlag(propName),
        type: 'string',
        required: requiredProps.includes(propName),
        description: `${capitalize(propName)} connector name`,
        role: 'name',
        path: [propName, 'name'],
        parentProp: propName,
      })
      flags.push({
        name: toOptName(propName + '_config'),
        cliFlag: '--' + toCliFlag(propName + '_config'),
        type: 'string',
        required: false,
        description: `Additional ${propName} config (JSON or @file)`,
        role: 'config',
        path: [propName],
        parentProp: propName,
      })
    } else if (isNamedArray(resolved)) {
      // Array of objects with required name → comma-separated list
      flags.push({
        name: toOptName(propName),
        cliFlag: '--' + toCliFlag(propName),
        type: 'string',
        required: requiredProps.includes(propName),
        description: `${capitalize(propName)} names, comma-separated`,
        role: 'list',
        path: [propName],
      })
    } else if (isOpenObject(resolved)) {
      // Open object (additionalProperties, no named properties) → json
      flags.push({
        name: toOptName(propName),
        cliFlag: '--' + toCliFlag(propName),
        type: 'string',
        required: requiredProps.includes(propName),
        description: resolved.description ?? `${capitalize(propName)} (JSON or @file)`,
        role: 'json',
        path: [propName],
      })
    } else {
      // Simple scalar
      flags.push({
        name: toOptName(propName),
        cliFlag: '--' + toCliFlag(propName),
        type: 'string',
        required: requiredProps.includes(propName),
        description: resolved.description ?? capitalize(propName),
        role: 'scalar',
        path: [propName],
      })
    }
  }

  // Always add a base-config flag for the entire JSON header
  const headerLabel = stripXPrefix(param.name)
  flags.push({
    name: 'config',
    cliFlag: '--config',
    type: 'string',
    required: false,
    description: `Full ${headerLabel} config (JSON or @file, flags override)`,
    role: 'base-config',
    path: [],
  })

  return flags
}

/** Object with { properties: { name: string }, additionalProperties: true } */
function isNamedObject(schema: ExtendedSchema): boolean {
  if (schema.type !== 'object') return false
  const nameField = schema.properties?.['name']
  if (!nameField) return false
  if (nameField.type !== 'string') return false
  return schema.additionalProperties === true
}

/** Array whose items are objects with a required `name` property. */
function isNamedArray(schema: ExtendedSchema): boolean {
  if (schema.type !== 'array') return false
  const items = schema.items
  if (!items || items.type !== 'object') return false
  return (items.required ?? []).includes('name')
}

/** Object with additionalProperties but no named properties. */
function isOpenObject(schema: ExtendedSchema): boolean {
  if (schema.type !== 'object') return false
  const hasProps = schema.properties && Object.keys(schema.properties).length > 0
  return !hasProps && schema.additionalProperties != null && schema.additionalProperties !== false
}

function stripXPrefix(name: string): string {
  return name.replace(/^x-/, '')
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
