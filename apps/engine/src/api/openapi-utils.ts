// ── Generic helpers ──────────────────────────────────────────────

export function endpointTable(spec: { paths?: Record<string, unknown> }): string {
  const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete'])
  const rows = Object.entries(spec.paths ?? {}).flatMap(([path, methods]) =>
    Object.entries(methods as Record<string, { summary?: string }>)
      .filter(([m]) => HTTP_METHODS.has(m))
      .map(([method, op]) => `| ${method.toUpperCase()} | ${path} | ${op.summary ?? ''} |`)
  )
  return ['| Method | Path | Summary |', '|--------|------|---------|', ...rows].join('\n')
}

/**
 * Add `discriminator: { propertyName: "type" }` to every `oneOf` whose
 * variants all define a `type` property with a single const or enum value.
 *
 * zod-openapi only generates `discriminator.mapping` when variants have
 * `.meta({ id })`. For inline variants (e.g. SourceConfig, DestinationConfig),
 * this post-processing adds the discriminator hint that code generators need.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function addDiscriminators(node: any): void {
  if (node == null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) addDiscriminators(item)
    return
  }
  if (Array.isArray(node.oneOf)) {
    const allHaveTypeDiscriminator = node.oneOf.every(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (v: any) =>
        v?.type === 'object' &&
        (v?.properties?.type?.enum?.length === 1 || v?.properties?.type?.const !== undefined)
    )
    if (allHaveTypeDiscriminator && !node.discriminator) {
      node.discriminator = { propertyName: 'type' }
    }
  }
  for (const value of Object.values(node)) {
    addDiscriminators(value)
  }
}
