import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  ReporterDispatcher,
  createReporters,
  type PilotReporter,
  type FullResult,
} from '../reporter.js'
import type { PilotConfig } from '../config.js'
import type { TestResult } from '../runner.js'

// ─── Test data helpers ───

function makeTestResult(overrides: Partial<TestResult> = {}): TestResult {
  return {
    name: 'my test',
    fullName: 'suite > my test',
    status: 'passed',
    durationMs: 42,
    ...overrides,
  }
}

function makeFullResult(overrides: Partial<FullResult> = {}): FullResult {
  return {
    status: 'passed',
    duration: 1000,
    tests: [makeTestResult()],
    suites: [],
    ...overrides,
  }
}

function makeConfig(overrides: Partial<PilotConfig> = {}): PilotConfig {
  return {
    timeout: 30_000,
    retries: 0,
    screenshot: 'only-on-failure',
    testMatch: ['**/*.test.ts'],
    daemonAddress: 'localhost:50051',
    rootDir: '/tmp/test',
    outputDir: 'pilot-results',
    workers: 1,
    fullyParallel: false,
    ...overrides,
  }
}

// ─── ReporterDispatcher ───

describe('ReporterDispatcher', () => {
  it('fans out onRunStart to all reporters', () => {
    const r1: PilotReporter = { onRunStart: vi.fn() }
    const r2: PilotReporter = { onRunStart: vi.fn() }
    const dispatcher = new ReporterDispatcher([r1, r2])

    const config = makeConfig()
    dispatcher.onRunStart(config, 3)

    expect(r1.onRunStart).toHaveBeenCalledWith(config, 3)
    expect(r2.onRunStart).toHaveBeenCalledWith(config, 3)
  })

  it('fans out onTestEnd to all reporters', () => {
    const r1: PilotReporter = { onTestEnd: vi.fn() }
    const r2: PilotReporter = { onTestEnd: vi.fn() }
    const dispatcher = new ReporterDispatcher([r1, r2])

    const test = makeTestResult()
    dispatcher.onTestEnd(test)

    expect(r1.onTestEnd).toHaveBeenCalledWith(test)
    expect(r2.onTestEnd).toHaveBeenCalledWith(test)
  })

  it('fans out onTestFileStart to all reporters', () => {
    const r1: PilotReporter = { onTestFileStart: vi.fn() }
    const dispatcher = new ReporterDispatcher([r1])

    dispatcher.onTestFileStart('/path/to/test.ts')
    expect(r1.onTestFileStart).toHaveBeenCalledWith('/path/to/test.ts')
  })

  it('fans out onTestFileEnd to all reporters', () => {
    const r1: PilotReporter = { onTestFileEnd: vi.fn() }
    const dispatcher = new ReporterDispatcher([r1])

    const results = [makeTestResult()]
    dispatcher.onTestFileEnd('/path/to/test.ts', results)
    expect(r1.onTestFileEnd).toHaveBeenCalledWith('/path/to/test.ts', results)
  })

  it('fans out onRunEnd to all reporters', async () => {
    const r1: PilotReporter = { onRunEnd: vi.fn() }
    const r2: PilotReporter = { onRunEnd: vi.fn() }
    const dispatcher = new ReporterDispatcher([r1, r2])

    const result = makeFullResult()
    await dispatcher.onRunEnd(result)

    expect(r1.onRunEnd).toHaveBeenCalledWith(result)
    expect(r2.onRunEnd).toHaveBeenCalledWith(result)
  })

  it('fans out onError to all reporters', () => {
    const r1: PilotReporter = { onError: vi.fn() }
    const dispatcher = new ReporterDispatcher([r1])

    const error = new Error('boom')
    dispatcher.onError(error)
    expect(r1.onError).toHaveBeenCalledWith(error)
  })

  it('catches errors in reporters without breaking other reporters', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const r1: PilotReporter = {
      onTestEnd: () => {
        throw new Error('reporter broke')
      },
    }
    const r2: PilotReporter = { onTestEnd: vi.fn() }
    const dispatcher = new ReporterDispatcher([r1, r2])

    dispatcher.onTestEnd(makeTestResult())

    // r2 should still be called
    expect(r2.onTestEnd).toHaveBeenCalled()
    // Error should be logged to stderr
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('reporter broke'))
    stderrSpy.mockRestore()
  })

  it('handles reporters that only implement some hooks', () => {
    const r1: PilotReporter = {} // no hooks
    const dispatcher = new ReporterDispatcher([r1])

    // Should not throw
    dispatcher.onRunStart(makeConfig(), 1)
    dispatcher.onTestEnd(makeTestResult())
    dispatcher.onTestFileStart('/test.ts')
    dispatcher.onTestFileEnd('/test.ts', [])
    dispatcher.onError(new Error('test'))
  })

  it('awaits async onRunEnd reporters sequentially', async () => {
    const order: string[] = []
    const r1: PilotReporter = {
      onRunEnd: async () => {
        await new Promise((r) => setTimeout(r, 10))
        order.push('r1')
      },
    }
    const r2: PilotReporter = {
      onRunEnd: async () => {
        order.push('r2')
      },
    }
    const dispatcher = new ReporterDispatcher([r1, r2])
    await dispatcher.onRunEnd(makeFullResult())

    expect(order).toEqual(['r1', 'r2'])
  })
})

// ─── createReporters ───

describe('createReporters', () => {
  it('creates a list reporter by default when not in CI', async () => {
    const origCI = process.env.CI
    delete process.env.CI

    const reporters = await createReporters(undefined)
    expect(reporters).toHaveLength(1)
    expect(reporters[0].constructor.name).toBe('ListReporter')

    if (origCI !== undefined) process.env.CI = origCI
  })

  it('creates a dot reporter by default when in CI', async () => {
    const origCI = process.env.CI
    process.env.CI = 'true'

    const reporters = await createReporters(undefined)
    expect(reporters).toHaveLength(1)
    expect(reporters[0].constructor.name).toBe('DotReporter')

    if (origCI !== undefined) {
      process.env.CI = origCI
    } else {
      delete process.env.CI
    }
  })

  it('creates a single reporter from a string', async () => {
    const reporters = await createReporters('dot')
    expect(reporters).toHaveLength(1)
    expect(reporters[0].constructor.name).toBe('DotReporter')
  })

  it('creates a reporter with options from a tuple', async () => {
    const reporters = await createReporters(['json', { outputFile: 'custom.json' }])
    expect(reporters).toHaveLength(1)
    expect(reporters[0].constructor.name).toBe('JsonReporter')
  })

  it('creates multiple reporters from an array', async () => {
    const reporters = await createReporters(['list', 'dot'])
    expect(reporters).toHaveLength(2)
    expect(reporters[0].constructor.name).toBe('ListReporter')
    expect(reporters[1].constructor.name).toBe('DotReporter')
  })

  it('creates multiple reporters with mixed config', async () => {
    const reporters = await createReporters([
      'list',
      ['json', { outputFile: 'out.json' }],
    ])
    expect(reporters).toHaveLength(2)
    expect(reporters[0].constructor.name).toBe('ListReporter')
    expect(reporters[1].constructor.name).toBe('JsonReporter')
  })

  it('creates all built-in reporter types', async () => {
    const names = ['list', 'line', 'dot', 'json', 'junit', 'html', 'github', 'blob']
    for (const name of names) {
      const reporters = await createReporters(name)
      expect(reporters).toHaveLength(1)
    }
  })

  it('throws for unknown reporter name', async () => {
    await expect(createReporters('nonexistent-reporter-xyz')).rejects.toThrow(
      /Unknown reporter "nonexistent-reporter-xyz"/,
    )
  })
})

// ─── Individual reporter behavior ───

describe('ListReporter', () => {
  let reporter: PilotReporter
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdoutSpy: any

  beforeEach(async () => {
    const { ListReporter } = await import('../reporters/list.js')
    reporter = new ListReporter()
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })

  it('prints file header on onTestFileStart', () => {
    reporter.onTestFileStart!('/path/to/test.ts')
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('test.ts'))
  })

  it('prints test result with status icon', () => {
    reporter.onRunStart!(makeConfig(), 1)
    reporter.onTestEnd!(makeTestResult({ status: 'passed', fullName: 'my passing test' }))
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]).join('')
    expect(output).toContain('my passing test')
  })

  it('prints error details for failed tests', () => {
    reporter.onRunStart!(makeConfig(), 1)
    reporter.onTestEnd!(makeTestResult({
      status: 'failed',
      fullName: 'failing test',
      error: new Error('assertion failed'),
    }))
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]).join('')
    expect(output).toContain('assertion failed')
  })

  it('prints summary on onRunEnd', () => {
    reporter.onRunEnd!(makeFullResult({
      tests: [
        makeTestResult({ status: 'passed' }),
        makeTestResult({ status: 'failed', error: new Error('fail') }),
        makeTestResult({ status: 'skipped' }),
      ],
    }))
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]).join('')
    expect(output).toContain('1 passed')
    expect(output).toContain('1 failed')
    expect(output).toContain('1 skipped')
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
  })
})

describe('DotReporter', () => {
  let reporter: PilotReporter
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdoutSpy: any

  beforeEach(async () => {
    const { DotReporter } = await import('../reporters/dot.js')
    reporter = new DotReporter()
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })

  it('outputs a character per test', () => {
    reporter.onRunStart!(makeConfig(), 1)
    reporter.onTestEnd!(makeTestResult({ status: 'passed' }))
    reporter.onTestEnd!(makeTestResult({ status: 'failed', error: new Error('x') }))
    reporter.onTestEnd!(makeTestResult({ status: 'skipped' }))

    // Should have written dot characters (with ANSI color codes)
    // 3 test results + 1 header newline = at least 4 write calls
    expect(stdoutSpy.mock.calls.length).toBeGreaterThanOrEqual(4)
    // Strip ANSI codes and verify the actual dot characters
    const raw = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]).join('')
    const stripped = raw.replace(/\x1b\[\d+m/g, '')
    expect(stripped).toContain('·')
    expect(stripped).toContain('F')
    expect(stripped).toContain('×')
  })

  it('prints failure summary on onRunEnd', () => {
    reporter.onRunStart!(makeConfig(), 1)
    reporter.onTestEnd!(makeTestResult({
      status: 'failed',
      fullName: 'broken test',
      error: new Error('oops'),
    }))
    reporter.onRunEnd!(makeFullResult({
      tests: [makeTestResult({ status: 'failed', fullName: 'broken test', error: new Error('oops') })],
    }))
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]).join('')
    expect(output).toContain('broken test')
    expect(output).toContain('oops')
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
  })
})

describe('GitHubActionsReporter', () => {
  let reporter: PilotReporter
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdoutSpy: any

  beforeEach(async () => {
    const { GitHubActionsReporter } = await import('../reporters/github.js')
    reporter = new GitHubActionsReporter()
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })

  it('emits ::error annotation for failed tests', () => {
    reporter.onTestEnd!(makeTestResult({
      status: 'failed',
      fullName: 'login > rejects invalid password',
      error: new Error('Expected element to be visible'),
    }))
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]).join('')
    expect(output).toContain('::error')
    expect(output).toContain('Expected element to be visible')
  })

  it('does not emit annotations for passing tests', () => {
    reporter.onTestEnd!(makeTestResult({ status: 'passed' }))
    expect(stdoutSpy).not.toHaveBeenCalled()
  })

  it('does not emit annotations for skipped tests', () => {
    reporter.onTestEnd!(makeTestResult({ status: 'skipped' }))
    expect(stdoutSpy).not.toHaveBeenCalled()
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
  })
})

describe('JsonReporter', () => {
  it('writes JSON report to file on onRunEnd', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const os = await import('node:os')

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-json-'))
    const outputFile = path.join(tmpDir, 'results.json')

    const { JsonReporter } = await import('../reporters/json.js')
    const reporter = new JsonReporter({ outputFile })

    reporter.onRunStart!(makeConfig({ rootDir: '/' }), 1)
    await reporter.onRunEnd!(makeFullResult({
      tests: [
        makeTestResult({ status: 'passed', fullName: 'test a' }),
        makeTestResult({ status: 'failed', fullName: 'test b', error: new Error('fail') }),
      ],
      suites: [{
        name: 'suite',
        durationMs: 100,
        tests: [
          makeTestResult({ status: 'passed', fullName: 'test a' }),
          makeTestResult({ status: 'failed', fullName: 'test b', error: new Error('fail') }),
        ],
        suites: [],
      }],
    }))

    const report = JSON.parse(fs.readFileSync(outputFile, 'utf-8'))
    expect(report.stats.total).toBe(2)
    expect(report.stats.passed).toBe(1)
    expect(report.stats.failed).toBe(1)
    expect(report.suites).toHaveLength(1)
    expect(report.suites[0].tests).toHaveLength(2)

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true })
  })
})

describe('JUnitReporter', () => {
  it('writes JUnit XML to file on onRunEnd', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const os = await import('node:os')

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-junit-'))
    const outputFile = path.join(tmpDir, 'results.xml')

    const { JUnitReporter } = await import('../reporters/junit.js')
    const reporter = new JUnitReporter({ outputFile })

    reporter.onRunStart!(makeConfig({ rootDir: '/' }), 1)
    await reporter.onRunEnd!(makeFullResult({
      tests: [
        makeTestResult({ status: 'passed', fullName: 'test a' }),
        makeTestResult({ status: 'failed', fullName: 'test b', error: new Error('assert fail') }),
        makeTestResult({ status: 'skipped', fullName: 'test c' }),
      ],
      suites: [{
        name: 'suite',
        durationMs: 200,
        tests: [
          makeTestResult({ status: 'passed', fullName: 'test a' }),
          makeTestResult({ status: 'failed', fullName: 'test b', error: new Error('assert fail') }),
          makeTestResult({ status: 'skipped', fullName: 'test c' }),
        ],
        suites: [],
      }],
    }))

    const xml = fs.readFileSync(outputFile, 'utf-8')
    expect(xml).toContain('<?xml version="1.0"')
    expect(xml).toContain('<testsuites')
    expect(xml).toContain('tests="3"')
    expect(xml).toContain('failures="1"')
    expect(xml).toContain('<skipped/>')
    expect(xml).toContain('assert fail')

    fs.rmSync(tmpDir, { recursive: true })
  })

  it('escapes XML special characters', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const os = await import('node:os')

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-junit-'))
    const outputFile = path.join(tmpDir, 'results.xml')

    const { JUnitReporter } = await import('../reporters/junit.js')
    const reporter = new JUnitReporter({ outputFile })

    reporter.onRunStart!(makeConfig({ rootDir: '/' }), 1)
    await reporter.onRunEnd!(makeFullResult({
      tests: [
        makeTestResult({
          status: 'failed',
          fullName: 'test <with> "special" & chars',
          error: new Error('Expected <div> & "value"'),
        }),
      ],
    }))

    const xml = fs.readFileSync(outputFile, 'utf-8')
    expect(xml).toContain('&lt;with&gt;')
    expect(xml).toContain('&amp;')
    expect(xml).toContain('&quot;')

    fs.rmSync(tmpDir, { recursive: true })
  })
})

describe('HtmlReporter', () => {
  it('writes an HTML report on onRunEnd', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const os = await import('node:os')

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-html-'))

    const { HtmlReporter } = await import('../reporters/html.js')
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const reporter = new HtmlReporter({ outputFolder: tmpDir, open: 'never' })

    reporter.onRunStart!(makeConfig({ rootDir: '/' }), 1)
    await reporter.onRunEnd!(makeFullResult({
      tests: [
        makeTestResult({ status: 'passed', fullName: 'test a' }),
        makeTestResult({ status: 'failed', fullName: 'test b', error: new Error('oops') }),
      ],
    }))

    const indexPath = path.join(tmpDir, 'index.html')
    expect(fs.existsSync(indexPath)).toBe(true)

    const html = fs.readFileSync(indexPath, 'utf-8')
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('Pilot Test Report')
    expect(html).toContain('test a')
    expect(html).toContain('test b')

    stderrSpy.mockRestore()
    fs.rmSync(tmpDir, { recursive: true })
  })
})

describe('BlobReporter', () => {
  it('writes a blob file and can be merged', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const os = await import('node:os')

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-blob-'))

    const { BlobReporter, mergeBlobs } = await import('../reporters/blob.js')
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const reporter = new BlobReporter({ outputDir: tmpDir })

    reporter.onRunStart!(makeConfig({ rootDir: '/' }), 1)
    await reporter.onRunEnd!(makeFullResult({
      tests: [
        makeTestResult({ status: 'passed', fullName: 'shard1 test' }),
        makeTestResult({ status: 'failed', fullName: 'shard1 fail', error: new Error('err') }),
      ],
      suites: [{
        name: 'suite1',
        durationMs: 100,
        tests: [
          makeTestResult({ status: 'passed', fullName: 'shard1 test' }),
          makeTestResult({ status: 'failed', fullName: 'shard1 fail', error: new Error('err') }),
        ],
        suites: [],
      }],
    }))

    // Verify blob files exist
    const blobFiles = fs.readdirSync(tmpDir).filter((f: string) => f.endsWith('.jsonl'))
    expect(blobFiles.length).toBeGreaterThan(0)

    // Merge and verify
    const merged = mergeBlobs(tmpDir)
    expect(merged.tests).toHaveLength(2)
    expect(merged.tests[0].fullName).toBe('shard1 test')
    expect(merged.tests[1].fullName).toBe('shard1 fail')
    expect(merged.tests[1].error?.message).toBe('err')
    expect(merged.suites).toHaveLength(1)

    stderrSpy.mockRestore()
    fs.rmSync(tmpDir, { recursive: true })
  })
})

// ─── Base formatting utilities ───

describe('base formatting utilities', () => {
  it('formatDuration formats milliseconds and seconds', async () => {
    const { formatDuration } = await import('../reporters/base.js')
    expect(formatDuration(42)).toBe('42ms')
    expect(formatDuration(1500)).toBe('1.5s')
    expect(formatDuration(999)).toBe('999ms')
    expect(formatDuration(1000)).toBe('1.0s')
  })

  it('statusIcon returns different icons per status', async () => {
    const { statusIcon } = await import('../reporters/base.js')
    const passed = statusIcon('passed')
    const failed = statusIcon('failed')
    const skipped = statusIcon('skipped')

    // They should all be different (include ANSI codes)
    expect(passed).not.toBe(failed)
    expect(failed).not.toBe(skipped)
  })

  it('formatError includes message and stack', async () => {
    const { formatError } = await import('../reporters/base.js')
    const err = new Error('test error')
    const output = formatError(err)
    expect(output).toContain('test error')
  })
})
