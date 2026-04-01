import type { Destination, ConfiguredCatalog } from '@stripe/sync-protocol'

export type CatalogMiddleware = (catalog: ConfiguredCatalog) => ConfiguredCatalog

/**
 * Prune each stream's json_schema.properties down to the fields selected in
 * ConfiguredStream.fields (plus all primary-key fields).
 * Streams without fields or without json_schema pass through unchanged.
 */
export function catalogFilter(catalog: ConfiguredCatalog): ConfiguredCatalog {
  return {
    streams: catalog.streams.map((cs) => {
      if (!cs.fields?.length) return cs
      const props = cs.stream.json_schema?.properties as Record<string, unknown> | undefined
      if (!props) return cs
      const allowed = new Set(cs.fields)
      for (const path of cs.stream.primary_key) {
        if (path[0]) allowed.add(path[0])
      }
      return {
        ...cs,
        stream: {
          ...cs.stream,
          json_schema: {
            ...cs.stream.json_schema,
            properties: Object.fromEntries(Object.entries(props).filter(([k]) => allowed.has(k))),
          },
        },
      }
    }),
  }
}

/**
 * Wrap a Destination, applying one or more CatalogMiddleware transforms to the
 * catalog before it reaches setup() and write(). Transforms are applied left-to-right.
 */
export function composeDestination(
  dest: Destination,
  ...middlewares: CatalogMiddleware[]
): Destination {
  const transform: CatalogMiddleware = middlewares.reduce(
    (f, g) => (catalog) => g(f(catalog)),
    (catalog: ConfiguredCatalog) => catalog
  )
  return {
    spec: () => dest.spec(),
    check: (params) => dest.check(params),
    write(params, $stdin) {
      return dest.write({ ...params, catalog: transform(params.catalog) }, $stdin)
    },
    ...(dest.setup && {
      async setup(params) {
        return dest.setup!({ ...params, catalog: transform(params.catalog) })
      },
    }),
    ...(dest.teardown && {
      teardown: (params: { config: Record<string, unknown> }) => dest.teardown!(params),
    }),
  }
}
