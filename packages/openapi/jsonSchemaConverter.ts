import type { JsonShape, ParsedResourceTable, ScalarType } from './types.js'

const SCALAR_TYPE_TO_JSON_SCHEMA: Record<
  Exclude<ScalarType, 'json'>,
  { type: string; format?: string }
> = {
  text: { type: 'string' },
  boolean: { type: 'boolean' },
  bigint: { type: 'integer' },
  numeric: { type: 'number' },
  timestamptz: { type: 'string', format: 'date-time' },
}

function withNullable(schema: Record<string, unknown>, nullable: boolean): Record<string, unknown> {
  return nullable ? { oneOf: [schema, { type: 'null' }] } : schema
}

function jsonShapeToJsonSchema(shape: JsonShape | undefined): Record<string, unknown> {
  if (shape === 'array') return { type: 'array' }
  if (shape === 'object' || shape === undefined) return { type: 'object' }
  return {}
}

export function parsedTableToJsonSchema(table: ParsedResourceTable): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    id: { type: 'string' },
  }
  const required: string[] = ['id']

  for (const col of table.columns) {
    const mapped: Record<string, unknown> = col.expandableReference
      ? {
          type: 'string',
          'x-expandable-reference': true,
          ...(col.expansionResourceIds?.length
            ? { 'x-expansion-resources': col.expansionResourceIds }
            : {}),
        }
      : col.type === 'json'
        ? jsonShapeToJsonSchema(col.jsonShape)
        : SCALAR_TYPE_TO_JSON_SCHEMA[col.type]

    properties[col.name] = withNullable(mapped, col.nullable)
    if (!col.nullable) {
      required.push(col.name)
    }
  }

  return {
    type: 'object',
    properties,
    required,
  }
}
