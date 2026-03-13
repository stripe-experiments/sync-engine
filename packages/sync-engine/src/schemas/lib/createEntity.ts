import { Entity, Column, PrimaryColumn } from 'typeorm'

type PgType = 'text' | 'numeric' | 'boolean' | 'jsonb'

interface ColumnOptions {
  type: PgType
  nullable?: boolean
  primary?: boolean
}

type ColumnDef = PgType | ColumnOptions

export type ColumnDefs<T> = { [K in keyof T]?: ColumnDef }

function normalize(def: ColumnDef): ColumnOptions {
  return typeof def === 'string' ? { type: def } : def
}

/**
 * Dynamically creates a TypeORM entity class by applying @Entity, @PrimaryColumn,
 * and @Column decorators programmatically from a column definition map.
 *
 * Non-nullable columns can use the shorthand string form: `balance: 'numeric'`
 * Nullable/primary columns use the object form: `id: { type: 'text', primary: true }`
 */
export function createEntity<T>(tableName: string, columns: ColumnDefs<T>): new () => T {
  class DynamicEntity {}
  Object.defineProperty(DynamicEntity, 'name', { value: tableName })
  Entity(tableName)(DynamicEntity)

  for (const [name, rawDef] of Object.entries(columns)) {
    const col = normalize(rawDef as ColumnDef)
    if (col.primary) {
      PrimaryColumn({ type: col.type })(DynamicEntity.prototype, name)
    } else {
      Column({ type: col.type, nullable: col.nullable ?? false })(DynamicEntity.prototype, name)
    }
  }

  return DynamicEntity as unknown as new () => T
}
