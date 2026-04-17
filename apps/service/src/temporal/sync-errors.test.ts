import { describe, it, expect } from 'vitest'
import { classifySyncErrors } from './sync-errors.js'

describe('classifySyncErrors', () => {
  it('classifies global permanent errors (no stream field)', () => {
    const result = classifySyncErrors([{ message: 'bad key', failure_type: 'auth_error' }])

    expect(result.globalPermanent).toHaveLength(1)
    expect(result.streamPermanent).toHaveLength(0)
    expect(result.permanent).toHaveLength(1)
    expect(result.transient).toHaveLength(0)
  })

  it('classifies stream-scoped permanent errors', () => {
    const result = classifySyncErrors([
      { message: 'stream auth fail', failure_type: 'auth_error', stream: 'treasury' },
    ])

    expect(result.globalPermanent).toHaveLength(0)
    expect(result.streamPermanent).toHaveLength(1)
    expect(result.permanent).toHaveLength(1)
    expect(result.transient).toHaveLength(0)
  })

  it('classifies transient errors regardless of stream scope', () => {
    const result = classifySyncErrors([
      { message: 'rate limit', failure_type: 'transient_error', stream: 'customers' },
      { message: 'timeout', failure_type: 'transient_error' },
    ])

    expect(result.transient).toHaveLength(2)
    expect(result.permanent).toHaveLength(0)
    expect(result.globalPermanent).toHaveLength(0)
    expect(result.streamPermanent).toHaveLength(0)
  })

  it('classifies system_error as permanent', () => {
    const result = classifySyncErrors([
      { message: 'deterministic failure', failure_type: 'system_error', stream: 'treasury' },
    ])

    expect(result.permanent).toHaveLength(1)
    expect(result.streamPermanent).toHaveLength(1)
    expect(result.transient).toHaveLength(0)
  })

  it('separates mixed errors into correct buckets', () => {
    const result = classifySyncErrors([
      { message: 'bad key', failure_type: 'auth_error' },
      { message: 'feature gate', failure_type: 'config_error', stream: 'treasury' },
      { message: 'rate limit', failure_type: 'transient_error' },
    ])

    expect(result.globalPermanent).toHaveLength(1)
    expect(result.globalPermanent[0].message).toBe('bad key')

    expect(result.streamPermanent).toHaveLength(1)
    expect(result.streamPermanent[0].message).toBe('feature gate')

    expect(result.permanent).toHaveLength(2)
    expect(result.transient).toHaveLength(1)
    expect(result.transient[0].message).toBe('rate limit')
  })

  it('treats unknown failure_type as transient', () => {
    const result = classifySyncErrors([{ message: 'unknown' }])

    expect(result.transient).toHaveLength(1)
    expect(result.permanent).toHaveLength(0)
  })
})
