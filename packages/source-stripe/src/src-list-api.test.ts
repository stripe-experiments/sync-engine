import { describe, expect, it } from 'vitest'
import type { SegmentState } from './index.js'
import { mergeAdjacentCompleted } from './src-list-api.js'

const seg = (
  index: number,
  gte: number,
  lt: number,
  status: 'pending' | 'complete'
): SegmentState => ({ index, gte, lt, pageCursor: null, status })

describe('mergeAdjacentCompleted', () => {
  it('returns empty array unchanged', () => {
    expect(mergeAdjacentCompleted([])).toEqual([])
  })

  it('leaves a single pending segment unchanged', () => {
    const input = [seg(0, 0, 100, 'pending')]
    expect(mergeAdjacentCompleted(input)).toEqual(input)
  })

  it('leaves a single complete segment unchanged', () => {
    const input = [seg(0, 0, 100, 'complete')]
    expect(mergeAdjacentCompleted(input)).toEqual(input)
  })

  it('merges two adjacent complete segments', () => {
    const input = [seg(0, 0, 100, 'complete'), seg(1, 100, 200, 'complete')]
    expect(mergeAdjacentCompleted(input)).toEqual([
      { index: 0, gte: 0, lt: 200, pageCursor: null, status: 'complete' },
    ])
  })

  it('merges three consecutive complete segments', () => {
    const input = [
      seg(0, 0, 100, 'complete'),
      seg(1, 100, 200, 'complete'),
      seg(2, 200, 300, 'complete'),
    ]
    expect(mergeAdjacentCompleted(input)).toEqual([
      { index: 0, gte: 0, lt: 300, pageCursor: null, status: 'complete' },
    ])
  })

  it('does not merge complete segments separated by a pending segment', () => {
    const input = [
      seg(0, 0, 100, 'complete'),
      seg(1, 100, 200, 'pending'),
      seg(2, 200, 300, 'complete'),
    ]
    expect(mergeAdjacentCompleted(input)).toEqual(input)
  })

  it('merges two groups independently', () => {
    const input = [
      seg(0, 0, 100, 'complete'),
      seg(1, 100, 200, 'complete'),
      seg(2, 200, 300, 'pending'),
      seg(3, 300, 400, 'complete'),
      seg(4, 400, 500, 'complete'),
    ]
    expect(mergeAdjacentCompleted(input)).toEqual([
      { index: 0, gte: 0, lt: 200, pageCursor: null, status: 'complete' },
      seg(2, 200, 300, 'pending'),
      { index: 3, gte: 300, lt: 500, pageCursor: null, status: 'complete' },
    ])
  })

  it('preserves index from the first segment in each merged group', () => {
    const input = [seg(5, 500, 600, 'complete'), seg(6, 600, 700, 'complete')]
    expect(mergeAdjacentCompleted(input)[0].index).toBe(5)
  })

  it('leaves all-pending array unchanged', () => {
    const input = [seg(0, 0, 100, 'pending'), seg(1, 100, 200, 'pending')]
    expect(mergeAdjacentCompleted(input)).toEqual(input)
  })
})
