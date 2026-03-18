import { describe, it, expect } from 'vitest'
import {
  serializeTestResult,
  deserializeTestResult,
  serializeSuiteResult,
  deserializeSuiteResult,
} from '../worker-protocol.js'
import type { TestResult, SuiteResult } from '../runner.js'

describe('worker-protocol serialization', () => {
  describe('serializeTestResult / deserializeTestResult', () => {
    it('round-trips a passing test', () => {
      const result: TestResult = {
        name: 'my test',
        fullName: 'suite > my test',
        status: 'passed',
        durationMs: 123,
      }

      const serialized = serializeTestResult(result, 2)
      expect(serialized.workerIndex).toBe(2)
      expect(serialized.error).toBeUndefined()

      const deserialized = deserializeTestResult(serialized)
      expect(deserialized.name).toBe('my test')
      expect(deserialized.fullName).toBe('suite > my test')
      expect(deserialized.status).toBe('passed')
      expect(deserialized.durationMs).toBe(123)
      expect(deserialized.workerIndex).toBe(2)
      expect(deserialized.error).toBeUndefined()
    })

    it('round-trips a failed test with error', () => {
      const error = new Error('assertion failed')
      error.stack = 'Error: assertion failed\n    at test.ts:10'

      const result: TestResult = {
        name: 'failing test',
        fullName: 'failing test',
        status: 'failed',
        durationMs: 456,
        error,
        screenshotPath: '/tmp/screenshot.png',
      }

      const serialized = serializeTestResult(result, 0)
      expect(serialized.error).toEqual({
        message: 'assertion failed',
        stack: 'Error: assertion failed\n    at test.ts:10',
      })
      expect(serialized.screenshotPath).toBe('/tmp/screenshot.png')

      const deserialized = deserializeTestResult(serialized)
      expect(deserialized.status).toBe('failed')
      expect(deserialized.error).toBeInstanceOf(Error)
      expect(deserialized.error!.message).toBe('assertion failed')
      expect(deserialized.screenshotPath).toBe('/tmp/screenshot.png')
    })

    it('round-trips a skipped test', () => {
      const result: TestResult = {
        name: 'skipped',
        fullName: 'skipped',
        status: 'skipped',
        durationMs: 0,
      }

      const serialized = serializeTestResult(result, 1)
      const deserialized = deserializeTestResult(serialized)
      expect(deserialized.status).toBe('skipped')
      expect(deserialized.durationMs).toBe(0)
    })
  })

  describe('serializeSuiteResult / deserializeSuiteResult', () => {
    it('round-trips a suite with nested suites and tests', () => {
      const suite: SuiteResult = {
        name: 'root',
        durationMs: 1000,
        tests: [
          { name: 'test1', fullName: 'root > test1', status: 'passed', durationMs: 100 },
          { name: 'test2', fullName: 'root > test2', status: 'failed', durationMs: 200, error: new Error('fail') },
        ],
        suites: [
          {
            name: 'child',
            durationMs: 500,
            tests: [
              { name: 'test3', fullName: 'root > child > test3', status: 'passed', durationMs: 300 },
            ],
            suites: [],
          },
        ],
      }

      const serialized = serializeSuiteResult(suite, 3)
      expect(serialized.tests[0].workerIndex).toBe(3)
      expect(serialized.suites[0].tests[0].workerIndex).toBe(3)

      const deserialized = deserializeSuiteResult(serialized)
      expect(deserialized.name).toBe('root')
      expect(deserialized.durationMs).toBe(1000)
      expect(deserialized.tests).toHaveLength(2)
      expect(deserialized.tests[1].error).toBeInstanceOf(Error)
      expect(deserialized.suites).toHaveLength(1)
      expect(deserialized.suites[0].tests[0].name).toBe('test3')
    })

    it('handles empty suite', () => {
      const suite: SuiteResult = {
        name: '',
        durationMs: 0,
        tests: [],
        suites: [],
      }

      const serialized = serializeSuiteResult(suite, 0)
      const deserialized = deserializeSuiteResult(serialized)
      expect(deserialized.tests).toEqual([])
      expect(deserialized.suites).toEqual([])
    })
  })
})
