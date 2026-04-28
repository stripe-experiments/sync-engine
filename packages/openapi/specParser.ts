import type {
  OpenApiSchemaObject,
  OpenApiSchemaOrReference,
  OpenApiSpec,
  ParseSpecOptions,
  ParsedColumn,
  ParsedOpenApiSpec,
  JsonShape,
  ScalarType,
} from './types.js'
import { OPENAPI_RESOURCE_TABLE_ALIASES } from './runtimeMappings.js'

const SCHEMA_REF_PREFIX = '#/components/schemas/'

const RESERVED_COLUMNS = new Set([
  'id',
  '_raw_data',
  '_synced_at',
  '_updated_at',
  '_account_id',
])

export { OPENAPI_RESOURCE_TABLE_ALIASES }

type ColumnAccumulator = {
  type: ScalarType
  jsonShape?: JsonShape
  nullable: boolean
  expandableReference: boolean
  expansionResourceIds: Set<string>
}

type PropertyCandidate = {
  schema: OpenApiSchemaOrReference
  required: boolean
}

type TypeInfo = {
  type: ScalarType
  jsonShape?: JsonShape
}

export class SpecParser {
  parse(spec: OpenApiSpec, options: ParseSpecOptions = {}): ParsedOpenApiSpec {
    const schemas = spec.components?.schemas
    if (!schemas || typeof schemas !== 'object') {
      throw new Error('OpenAPI spec is missing components.schemas')
    }

    const aliases = { ...OPENAPI_RESOURCE_TABLE_ALIASES, ...(options.resourceAliases ?? {}) }
    const excluded = new Set(options.excludedTables ?? [])
    const allowedTables = options.allowedTables
      ? new Set(options.allowedTables.filter((t) => !excluded.has(t)))
      : undefined
    const tableMap = new Map<
      string,
      {
        resourceId: string
        sourceSchemaName: string
        columns: Map<string, ColumnAccumulator>
      }
    >()

    for (const schemaName of Object.keys(schemas).sort((a, b) => a.localeCompare(b))) {
      const schema = this.resolveSchema({ $ref: `#/components/schemas/${schemaName}` }, spec)
      const resourceId = schema['x-resourceId']
      if (!resourceId || typeof resourceId !== 'string') {
        continue
      }

      const tableName = this.resolveTableName(resourceId, aliases)
      if (excluded.has(tableName) || (allowedTables && !allowedTables.has(tableName))) {
        continue
      }

      const propCandidates = this.collectPropertyCandidates(
        { $ref: `#/components/schemas/${schemaName}` },
        spec
      )
      const parsedColumns = this.parseColumns(propCandidates, spec)

      const existing =
        tableMap.get(tableName) ??
        ({
          resourceId,
          sourceSchemaName: schemaName,
          columns: new Map<string, ColumnAccumulator>(),
        } as const)

      for (const column of parsedColumns) {
        const current = existing.columns.get(column.name)
        if (!current) {
          existing.columns.set(column.name, {
            type: column.type,
            ...(column.jsonShape ? { jsonShape: column.jsonShape } : {}),
            nullable: column.nullable,
            expandableReference: column.expandableReference ?? false,
            expansionResourceIds: new Set(column.expansionResourceIds ?? []),
          })
          continue
        }
        const expansionResourceIds = new Set(current.expansionResourceIds)
        for (const resourceId of column.expansionResourceIds ?? []) {
          expansionResourceIds.add(resourceId)
        }
        existing.columns.set(column.name, {
          ...this.mergeTypeInfo(
            { type: current.type, jsonShape: current.jsonShape },
            { type: column.type, jsonShape: column.jsonShape }
          ),
          nullable: current.nullable || column.nullable,
          expandableReference: current.expandableReference || (column.expandableReference ?? false),
          expansionResourceIds,
        })
      }

      tableMap.set(tableName, existing)
    }

    const tables = Array.from(tableMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([tableName, table]) => ({
        tableName,
        resourceId: table.resourceId,
        sourceSchemaName: table.sourceSchemaName,
        columns: Array.from(table.columns.entries())
          .map(([name, value]) => ({
            name,
            type: value.type,
            ...(value.jsonShape ? { jsonShape: value.jsonShape } : {}),
            nullable: value.nullable,
            ...(value.expandableReference ? { expandableReference: true } : {}),
            ...(value.expansionResourceIds.size > 0
              ? { expansionResourceIds: [...value.expansionResourceIds].sort() }
              : {}),
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      }))

    return {
      apiVersion: spec.info?.version ?? spec.openapi ?? 'unknown',
      tables,
    }
  }

  /**
   * Extract x-resourceId values for every schema that is returned by a list
   * endpoint. Supports both v1 (object: "list") and v2 (next_page_url) formats.
   */
  discoverListableResourceIds(
    spec: OpenApiSpec,
    options: { includeNested: boolean } = { includeNested: false }
  ): Set<string> {
    const resourceIds = new Set<string>()
    const paths = spec.paths
    if (!paths) {
      return resourceIds
    }

    for (const [apiPath, pathItem] of Object.entries(paths)) {
      if (!options.includeNested && apiPath.includes('{')) continue

      const getOp = pathItem.get
      if (!getOp?.responses) continue

      const responseSchema = getOp.responses['200']?.content?.['application/json']?.schema
      if (!responseSchema) continue

      if (!this.isListResponseSchema(responseSchema)) continue

      const dataProp = responseSchema.properties?.data
      if (!dataProp || !('type' in dataProp) || dataProp.type !== 'array') continue

      const itemsRef = dataProp.items
      if (!itemsRef || !this.isReference(itemsRef)) continue
      if (!itemsRef.$ref.startsWith(SCHEMA_REF_PREFIX)) continue

      const schemaName = itemsRef.$ref.slice(SCHEMA_REF_PREFIX.length)
      const schema = spec.components?.schemas?.[schemaName]
      if (!schema || '$ref' in schema) continue

      const resourceId = schema['x-resourceId']
      if (resourceId && typeof resourceId === 'string') {
        resourceIds.add(resourceId)
      }
    }

    return resourceIds
  }

  /**
   * Extract x-resourceId values for every schema that has at least one webhook
   * event for create, update, or delete operations. Event schemas are identified
   * by the `x-stripeEvent` extension with a type ending in `.created`, `.updated`,
   * or `.deleted`. The referenced resource is resolved via `properties.object.$ref`.
   */
  discoverWebhookUpdatableResourceIds(spec: OpenApiSpec): Set<string> {
    const resourceIds = new Set<string>()
    const schemas = spec.components?.schemas
    if (!schemas) return resourceIds

    const CRUD_SUFFIXES = ['.created', '.updated', '.deleted']

    for (const schema of Object.values(schemas)) {
      if (!schema || '$ref' in schema) continue

      const stripeEvent = schema['x-stripeEvent']
      if (!stripeEvent || typeof stripeEvent !== 'object') continue

      const eventType = stripeEvent.type
      if (!eventType || !CRUD_SUFFIXES.some((suffix) => eventType.endsWith(suffix))) continue

      const objectProp = schema.properties?.object
      if (!objectProp || !this.isReference(objectProp)) continue
      if (!objectProp.$ref.startsWith(SCHEMA_REF_PREFIX)) continue

      const schemaName = objectProp.$ref.slice(SCHEMA_REF_PREFIX.length)
      const refSchema = schemas[schemaName]
      if (!refSchema || '$ref' in refSchema) continue

      const resourceId = refSchema['x-resourceId']
      if (resourceId && typeof resourceId === 'string') {
        resourceIds.add(resourceId)
      }
    }

    return resourceIds
  }

  /**
   * Detect whether a response schema describes a list endpoint.
   * v1 lists have `object: enum ["list"]` with a `data` array.
   * v2 lists have a `data` array with `next_page_url`.
   */
  private isListResponseSchema(schema: OpenApiSchemaObject): boolean {
    const dataProp = schema.properties?.data
    if (!dataProp || !('type' in dataProp) || dataProp.type !== 'array') return false

    const objectProp = schema.properties?.object
    if (objectProp && 'enum' in objectProp && objectProp.enum?.includes('list')) return true

    if (schema.properties?.next_page_url) return true

    return false
  }

  private resolveTableName(resourceId: string, aliases: Record<string, string>): string {
    const alias = aliases[resourceId]
    if (alias) {
      return alias
    }

    const normalized = resourceId.toLowerCase().replace(/[.]/g, '_')
    return normalized
  }

  private parseColumns(
    propCandidates: Map<string, PropertyCandidate[]>,
    spec: OpenApiSpec
  ): ParsedColumn[] {
    const columns: ParsedColumn[] = []
    for (const [propertyName, candidates] of Array.from(propCandidates.entries()).sort(([a], [b]) =>
      a.localeCompare(b)
    )) {
      if (propertyName === 'id') {
        continue
      }
      if (RESERVED_COLUMNS.has(propertyName)) {
        throw new Error(`OpenAPI field "${propertyName}" collides with a reserved sync column`)
      }
      const inferred = this.inferFromCandidates(candidates, spec)
      if (inferred.listEnvelope) {
        continue
      }
      columns.push({
        name: propertyName,
        type: inferred.type,
        ...(inferred.jsonShape ? { jsonShape: inferred.jsonShape } : {}),
        nullable: inferred.nullable,
        ...(inferred.expandableReference ? { expandableReference: true } : {}),
        ...(inferred.expansionResourceIds.length > 0
          ? { expansionResourceIds: inferred.expansionResourceIds }
          : {}),
      })
    }
    return columns
  }

  private inferFromCandidates(
    candidates: PropertyCandidate[],
    spec: OpenApiSpec
  ): {
    type: ScalarType
    jsonShape?: JsonShape
    nullable: boolean
    expandableReference: boolean
    expansionResourceIds: string[]
    listEnvelope: boolean
  } {
    if (candidates.length === 0) {
      return {
        type: 'text',
        nullable: true,
        expandableReference: false,
        expansionResourceIds: [],
        listEnvelope: false,
      }
    }

    let mergedType: ScalarType | null = null
    let mergedJsonShape: JsonShape | undefined
    let nullable = false
    let expandableReference = false
    let listEnvelope = false
    const expansionResourceIds = new Set<string>()
    for (const candidate of candidates) {
      const inferred = this.inferType(candidate.schema, spec)
      const merged: TypeInfo = mergedType
        ? this.mergeTypeInfo(
            { type: mergedType, jsonShape: mergedJsonShape },
            { type: inferred.type, jsonShape: inferred.jsonShape }
          )
        : { type: inferred.type, jsonShape: inferred.jsonShape }
      mergedType = merged.type
      mergedJsonShape = merged.jsonShape
      nullable = nullable || inferred.nullable || !candidate.required
      listEnvelope = listEnvelope || this.isListEnvelopeCandidate(candidate.schema, spec)
      const candidateExpansionResourceIds = this.expansionResourceIds(candidate.schema, spec)
      expandableReference = expandableReference || candidateExpansionResourceIds.length > 0
      for (const resourceId of candidateExpansionResourceIds) {
        expansionResourceIds.add(resourceId)
      }
    }

    return {
      type: expandableReference ? 'text' : (mergedType ?? 'text'),
      ...(expandableReference || !mergedJsonShape ? {} : { jsonShape: mergedJsonShape }),
      nullable,
      expandableReference,
      expansionResourceIds: [...expansionResourceIds].sort(),
      listEnvelope,
    }
  }

  private mergeTypes(left: ScalarType, right: ScalarType): ScalarType {
    if (left === right) return left
    if (left === 'json' || right === 'json') return 'json'
    if ((left === 'numeric' && right === 'bigint') || (left === 'bigint' && right === 'numeric')) {
      return 'numeric'
    }
    if (left === 'timestamptz' && right === 'text') return 'text'
    if (left === 'text' && right === 'timestamptz') return 'text'
    return 'text'
  }

  private mergeTypeInfo(
    left: TypeInfo,
    right: TypeInfo
  ): TypeInfo {
    const type = this.mergeTypes(left.type, right.type)
    if (type !== 'json') return { type }
    if (left.type !== 'json' || right.type !== 'json') return { type, jsonShape: 'any' }
    if (left.jsonShape === right.jsonShape) {
      return left.jsonShape ? { type, jsonShape: left.jsonShape } : { type }
    }
    return { type, jsonShape: 'any' }
  }

  private inferType(
    schemaOrRef: OpenApiSchemaOrReference,
    spec: OpenApiSpec
  ): { type: ScalarType; jsonShape?: JsonShape; nullable: boolean } {
    const schema = this.resolveSchema(schemaOrRef, spec)
    const nullable = Boolean(schema.nullable)

    if (schema.oneOf?.length) {
      const merged = this.inferFromCandidates(
        schema.oneOf.map((candidate) => ({ schema: candidate, required: true })),
        spec
      )
      return {
        type: merged.type,
        ...(merged.jsonShape ? { jsonShape: merged.jsonShape } : {}),
        nullable: nullable || merged.nullable,
      }
    }
    if (schema.anyOf?.length) {
      const merged = this.inferFromCandidates(
        schema.anyOf.map((candidate) => ({ schema: candidate, required: true })),
        spec
      )
      return {
        type: merged.type,
        ...(merged.jsonShape ? { jsonShape: merged.jsonShape } : {}),
        nullable: nullable || merged.nullable,
      }
    }
    if (schema.allOf?.length) {
      const merged = this.inferFromCandidates(
        schema.allOf.map((candidate) => ({ schema: candidate, required: true })),
        spec
      )
      return {
        type: merged.type,
        ...(merged.jsonShape ? { jsonShape: merged.jsonShape } : {}),
        nullable: nullable || merged.nullable,
      }
    }

    if (schema.type === 'boolean') return { type: 'boolean', nullable }
    if (schema.type === 'integer') return { type: 'bigint', nullable }
    if (schema.type === 'number') return { type: 'numeric', nullable }
    if (schema.type === 'string') {
      if (schema.format === 'date-time') {
        return { type: 'timestamptz', nullable }
      }
      return { type: 'text', nullable }
    }
    if (schema.type === 'array') return { type: 'json', jsonShape: 'array', nullable }
    if (schema.type === 'object') return { type: 'json', jsonShape: 'object', nullable }
    if (schema.properties || schema.additionalProperties) {
      return { type: 'json', jsonShape: 'object', nullable }
    }

    if (schema.enum && schema.enum.length > 0) {
      const values = schema.enum
      if (values.every((value) => typeof value === 'boolean')) {
        return { type: 'boolean', nullable }
      }
      if (values.every((value) => typeof value === 'number' && Number.isInteger(value))) {
        return { type: 'bigint', nullable }
      }
      if (values.every((value) => typeof value === 'number')) {
        return { type: 'numeric', nullable }
      }
    }

    return { type: 'text', nullable: true }
  }

  private expansionResourceIds(schemaOrRef: OpenApiSchemaOrReference, spec: OpenApiSpec): string[] {
    const schema = this.resolveSchema(schemaOrRef, spec)
    const refs = schema['x-expansionResources']?.oneOf ?? []
    const resourceIds = new Set<string>()
    for (const ref of refs) {
      const resource = this.resolveSchema(ref, spec)['x-resourceId']
      if (typeof resource === 'string') {
        resourceIds.add(resource)
      }
    }
    return [...resourceIds].sort()
  }

  private isListEnvelopeCandidate(
    schemaOrRef: OpenApiSchemaOrReference,
    spec: OpenApiSpec
  ): boolean {
    const schema = this.resolveSchema(schemaOrRef, spec)
    return this.isListResponseSchema(schema)
  }

  private collectPropertyCandidates(
    schemaOrRef: OpenApiSchemaOrReference,
    spec: OpenApiSpec,
    seenRefs = new Set<string>(),
    seenSchemas = new Set<OpenApiSchemaObject>(),
    forceOptional = false
  ): Map<string, PropertyCandidate[]> {
    if (this.isReference(schemaOrRef)) {
      if (seenRefs.has(schemaOrRef.$ref)) {
        return new Map()
      }
      seenRefs.add(schemaOrRef.$ref)
    }

    const schema = this.resolveSchema(schemaOrRef, spec)
    if (seenSchemas.has(schema)) {
      return new Map()
    }
    seenSchemas.add(schema)

    const merged = new Map<string, PropertyCandidate[]>()
    const required = new Set(schema.required ?? [])
    const pushProp = (name: string, value: OpenApiSchemaOrReference, isRequired: boolean) => {
      const existing = merged.get(name) ?? []
      existing.push({ schema: value, required: isRequired })
      merged.set(name, existing)
    }

    for (const [name, value] of Object.entries(schema.properties ?? {})) {
      pushProp(name, value, !forceOptional && required.has(name))
    }

    for (const subSchema of schema.allOf ?? []) {
      const subProps = this.collectPropertyCandidates(
        subSchema,
        spec,
        seenRefs,
        seenSchemas,
        forceOptional
      )
      for (const [name, candidates] of subProps.entries()) {
        for (const candidate of candidates) {
          const existing = merged.get(name) ?? []
          existing.push(candidate)
          merged.set(name, existing)
        }
      }
    }

    for (const composed of [schema.oneOf, schema.anyOf]) {
      if (!composed) continue
      for (const subSchema of composed) {
        const subProps = this.collectPropertyCandidates(subSchema, spec, seenRefs, seenSchemas, true)
        for (const [name, candidates] of subProps.entries()) {
          for (const candidate of candidates) {
            const existing = merged.get(name) ?? []
            existing.push(candidate)
            merged.set(name, existing)
          }
        }
      }
    }

    return merged
  }

  private resolveSchema(
    schemaOrRef: OpenApiSchemaOrReference,
    spec: OpenApiSpec
  ): OpenApiSchemaObject {
    if (!this.isReference(schemaOrRef)) {
      return schemaOrRef
    }

    if (!schemaOrRef.$ref.startsWith(SCHEMA_REF_PREFIX)) {
      throw new Error(`Unsupported OpenAPI reference: ${schemaOrRef.$ref}`)
    }
    const schemaName = schemaOrRef.$ref.slice(SCHEMA_REF_PREFIX.length)
    const resolved = spec.components?.schemas?.[schemaName]
    if (!resolved) {
      throw new Error(`Failed to resolve OpenAPI schema reference: ${schemaOrRef.$ref}`)
    }
    if (this.isReference(resolved)) {
      return this.resolveSchema(resolved, spec)
    }
    return resolved
  }

  private isReference(schemaOrRef: OpenApiSchemaOrReference): schemaOrRef is { $ref: string } {
    return typeof (schemaOrRef as { $ref?: string }).$ref === 'string'
  }
}
