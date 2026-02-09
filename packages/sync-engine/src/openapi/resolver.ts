/**
 * OpenAPI $ref resolution utilities
 *
 * Handles resolving $ref references within OpenAPI specifications, including
 * nested references and circular reference detection.
 */

import type { ResolverOptions } from './types'

/**
 * Resolves $ref references in OpenAPI specifications
 */
export class ReferenceResolver {
  private readonly spec: any
  private readonly maxDepth: number
  private readonly followCircular: boolean
  private visitedRefs = new Set<string>()

  constructor(spec: any, options: ResolverOptions = {}) {
    this.spec = spec
    this.maxDepth = options.maxDepth ?? 10
    this.followCircular = options.followCircular ?? false
  }

  /**
   * Resolve a $ref reference to its actual definition
   */
  resolve(refPath: string, currentDepth = 0): any {
    if (currentDepth > this.maxDepth) {
      throw new Error(`Maximum reference resolution depth (${this.maxDepth}) exceeded for: ${refPath}`)
    }

    if (this.visitedRefs.has(refPath)) {
      if (!this.followCircular) {
        // Return a placeholder for circular references
        return { type: 'object', description: `Circular reference: ${refPath}` }
      }
    }

    this.visitedRefs.add(refPath)

    try {
      const resolved = this.resolveRef(refPath)
      return this.resolveNestedRefs(resolved, currentDepth + 1)
    } finally {
      this.visitedRefs.delete(refPath)
    }
  }

  /**
   * Resolve nested $ref references within an object
   */
  resolveNestedRefs(obj: any, currentDepth = 0): any {
    if (currentDepth > this.maxDepth) {
      return obj
    }

    if (!obj || typeof obj !== 'object') {
      return obj
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this.resolveNestedRefs(item, currentDepth))
    }

    if (obj.$ref) {
      return this.resolve(obj.$ref, currentDepth)
    }

    const resolved: any = {}
    for (const [key, value] of Object.entries(obj)) {
      resolved[key] = this.resolveNestedRefs(value, currentDepth)
    }

    return resolved
  }

  /**
   * Parse and resolve a JSON Pointer reference
   */
  private resolveRef(refPath: string): any {
    if (!refPath.startsWith('#/')) {
      throw new Error(`Unsupported reference format: ${refPath}. Only internal references (#/...) are supported.`)
    }

    const path = refPath.substring(2) // Remove '#/'
    const parts = path.split('/').map(part => this.decodePointer(part))

    let current = this.spec
    for (const part of parts) {
      if (current === null || current === undefined) {
        throw new Error(`Cannot resolve reference ${refPath}: path does not exist`)
      }

      current = current[part]
    }

    if (current === undefined) {
      throw new Error(`Reference ${refPath} could not be resolved`)
    }

    return current
  }

  /**
   * Decode JSON Pointer escaped characters
   */
  private decodePointer(part: string): string {
    return part.replace(/~1/g, '/').replace(/~0/g, '~')
  }

  /**
   * Check if an object contains any $ref references
   */
  static hasReferences(obj: any): boolean {
    if (!obj || typeof obj !== 'object') {
      return false
    }

    if (Array.isArray(obj)) {
      return obj.some(item => ReferenceResolver.hasReferences(item))
    }

    if (obj.$ref) {
      return true
    }

    return Object.values(obj).some(value => ReferenceResolver.hasReferences(value))
  }
}

/**
 * Utility function to resolve all $ref references in an object
 */
export function resolveReferences(spec: any, obj: any, options?: ResolverOptions): any {
  if (!ReferenceResolver.hasReferences(obj)) {
    return obj
  }

  const resolver = new ReferenceResolver(spec, options)
  return resolver.resolveNestedRefs(obj)
}