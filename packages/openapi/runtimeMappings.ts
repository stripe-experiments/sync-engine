/**
 * OpenAPI resource IDs project directly to table names. Dots are normalized to
 * underscores by `resolveTableName`; aliases are reserved for explicitly approved
 * schema exceptions.
 */
export const OPENAPI_RESOURCE_TABLE_ALIASES: Record<string, string> = {}
