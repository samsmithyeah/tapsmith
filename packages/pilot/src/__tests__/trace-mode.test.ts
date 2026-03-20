import { describe, it, expect } from 'vitest'
import { shouldRecord, shouldRetain } from '../trace/trace-mode.js'

describe('shouldRecord', () => {
  it('returns false for "off"', () => {
    expect(shouldRecord('off', 0)).toBe(false)
    expect(shouldRecord('off', 1)).toBe(false)
  })

  it('returns true for "on" regardless of attempt', () => {
    expect(shouldRecord('on', 0)).toBe(true)
    expect(shouldRecord('on', 1)).toBe(true)
    expect(shouldRecord('on', 5)).toBe(true)
  })

  it('returns true only on first retry for "on-first-retry"', () => {
    expect(shouldRecord('on-first-retry', 0)).toBe(false)
    expect(shouldRecord('on-first-retry', 1)).toBe(true)
    expect(shouldRecord('on-first-retry', 2)).toBe(false)
  })

  it('returns true on all retries for "on-all-retries"', () => {
    expect(shouldRecord('on-all-retries', 0)).toBe(false)
    expect(shouldRecord('on-all-retries', 1)).toBe(true)
    expect(shouldRecord('on-all-retries', 2)).toBe(true)
  })

  it('returns true for "retain-on-failure" regardless of attempt', () => {
    expect(shouldRecord('retain-on-failure', 0)).toBe(true)
    expect(shouldRecord('retain-on-failure', 1)).toBe(true)
  })

  it('returns true for "retain-on-first-failure" regardless of attempt', () => {
    expect(shouldRecord('retain-on-first-failure', 0)).toBe(true)
    expect(shouldRecord('retain-on-first-failure', 1)).toBe(true)
  })
})

describe('shouldRetain', () => {
  it('returns false for "off"', () => {
    expect(shouldRetain('off', true, 0)).toBe(false)
    expect(shouldRetain('off', false, 0)).toBe(false)
  })

  it('always retains for "on"', () => {
    expect(shouldRetain('on', true, 0)).toBe(true)
    expect(shouldRetain('on', false, 0)).toBe(true)
    expect(shouldRetain('on', true, 1)).toBe(true)
    expect(shouldRetain('on', false, 1)).toBe(true)
  })

  it('always retains for "on-first-retry"', () => {
    expect(shouldRetain('on-first-retry', true, 1)).toBe(true)
    expect(shouldRetain('on-first-retry', false, 1)).toBe(true)
  })

  it('always retains for "on-all-retries"', () => {
    expect(shouldRetain('on-all-retries', true, 1)).toBe(true)
    expect(shouldRetain('on-all-retries', false, 2)).toBe(true)
  })

  it('retains only on failure for "retain-on-failure"', () => {
    expect(shouldRetain('retain-on-failure', true, 0)).toBe(false)
    expect(shouldRetain('retain-on-failure', false, 0)).toBe(true)
    expect(shouldRetain('retain-on-failure', true, 1)).toBe(false)
    expect(shouldRetain('retain-on-failure', false, 1)).toBe(true)
  })

  it('retains only on first failure for "retain-on-first-failure"', () => {
    expect(shouldRetain('retain-on-first-failure', true, 0)).toBe(false)
    expect(shouldRetain('retain-on-first-failure', false, 0)).toBe(true)
    expect(shouldRetain('retain-on-first-failure', false, 1)).toBe(false)
    expect(shouldRetain('retain-on-first-failure', true, 1)).toBe(false)
  })
})
