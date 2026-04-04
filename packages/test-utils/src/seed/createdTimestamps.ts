export type CreatedTimestampOptions = {
  createdStart?: string | number
  createdEnd?: string | number
  nowMs?: number
}

export type CreatedTimestampRange = {
  startUnix: number
  endUnix: number
}

export function resolveCreatedTimestampRange(
  options: CreatedTimestampOptions
): CreatedTimestampRange | undefined {
  if (options.createdStart == null) return undefined

  const nowUnix = Math.floor((options.nowMs ?? Date.now()) / 1000)
  const startUnix = parseTimestamp(options.createdStart, 'createdStart')
  const endUnix = options.createdEnd != null
    ? parseTimestamp(options.createdEnd, 'createdEnd')
    : nowUnix

  if (startUnix > endUnix) {
    throw new Error('createdStart must be before createdEnd')
  }

  return { startUnix, endUnix }
}

function parseTimestamp(value: string | number, label: string): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Invalid ${label}: not a finite number`)
    return Math.floor(value)
  }
  const asNum = Number(value)
  if (Number.isFinite(asNum) && String(asNum) === value) {
    return Math.floor(asNum)
  }
  const ms = Date.parse(value)
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid ${label}: "${value}" is not a valid date or unix timestamp`)
  }
  return Math.floor(ms / 1000)
}

export function applyCreatedTimestampRange(
  objects: Record<string, unknown>[],
  range: CreatedTimestampRange | undefined
): Record<string, unknown>[] {
  if (!range) return objects
  if (objects.length === 0) return objects

  if (objects.length === 1) {
    return [{ ...objects[0], created: range.endUnix }]
  }

  const totalSpan = Math.max(0, range.endUnix - range.startUnix)
  return objects.map((object, index) => {
    const ratio = index / (objects.length - 1)
    const created = range.startUnix + Math.floor(totalSpan * ratio)
    return { ...object, created }
  })
}
