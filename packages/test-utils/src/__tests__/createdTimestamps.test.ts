import { describe, expect, it } from 'vitest'
import {
  applyCreatedTimestampRange,
  resolveCreatedTimestampRange,
} from '../seed/createdTimestamps.js'

describe('created timestamp range', () => {
  it('resolves start date string with end defaulting to now', () => {
    const nowMs = Date.UTC(2026, 3, 3)
    const range = resolveCreatedTimestampRange({ createdStart: '2021-04-03', nowMs })
    expect(range).toBeDefined()
    if (!range) return
    expect(range.startUnix).toBe(Math.floor(Date.parse('2021-04-03') / 1000))
    expect(range.endUnix).toBe(Math.floor(nowMs / 1000))
  })

  it('resolves unix timestamp start', () => {
    const range = resolveCreatedTimestampRange({ createdStart: 1617408000, createdEnd: 1700000000 })
    expect(range).toEqual({ startUnix: 1617408000, endUnix: 1700000000 })
  })

  it('resolves string unix timestamp', () => {
    const range = resolveCreatedTimestampRange({ createdStart: '1617408000', createdEnd: '1700000000' })
    expect(range).toEqual({ startUnix: 1617408000, endUnix: 1700000000 })
  })

  it('returns undefined when no start given', () => {
    expect(resolveCreatedTimestampRange({})).toBeUndefined()
  })

  it('rejects start after end', () => {
    expect(() =>
      resolveCreatedTimestampRange({ createdStart: 2000, createdEnd: 1000 })
    ).toThrowError(/before/)
  })

  it('spreads created timestamps over the whole range', () => {
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    const output = applyCreatedTimestampRange(rows, { startUnix: 1000, endUnix: 2000 })
    expect(output[0]?.created).toBe(1000)
    expect(output[1]?.created).toBe(1500)
    expect(output[2]?.created).toBe(2000)
  })
})
