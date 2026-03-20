import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { unzipSync, strFromU8 } from 'fflate'
import { TraceCollector } from '../trace/trace-collector.js'
import { packageTrace } from '../trace/trace-packager.js'
import type { TraceConfig } from '../trace/types.js'

describe('trace packager', () => {
  let tempDir: string
  let outputDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-trace-test-'))
    outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-trace-output-'))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
    fs.rmSync(outputDir, { recursive: true, force: true })
  })

  it('creates a valid zip with trace.json and metadata.json', () => {
    const config: TraceConfig = {
      mode: 'on',
      screenshots: false,
      snapshots: false,
      sources: false,
      attachments: true,
    }

    const collector = new TraceCollector(config, tempDir)
    collector.addActionEvent({
      category: 'tap',
      action: 'tap',
      selector: '{"text":"Hello"}',
      duration: 42,
      success: true,
      hasScreenshotBefore: false,
      hasScreenshotAfter: false,
      hasHierarchyBefore: false,
      hasHierarchyAfter: false,
    })
    collector.addActionEvent({
      category: 'type',
      action: 'type',
      inputValue: 'world',
      duration: 100,
      success: true,
      hasScreenshotBefore: false,
      hasScreenshotAfter: false,
      hasHierarchyBefore: false,
      hasHierarchyAfter: false,
    })

    const zipPath = packageTrace(collector, {
      testFile: 'test.ts',
      testName: 'my test',
      testStatus: 'passed',
      testDuration: 500,
      startTime: 1000,
      endTime: 1500,
      device: { serial: 'emulator-5554', isEmulator: true },
      pilotVersion: '0.1.0',
      outputDir,
    })

    expect(fs.existsSync(zipPath)).toBe(true)
    expect(zipPath.endsWith('.zip')).toBe(true)

    // Verify zip contents
    const zipData = new Uint8Array(fs.readFileSync(zipPath))
    const files = unzipSync(zipData)

    // metadata.json
    const metadata = JSON.parse(strFromU8(files['metadata.json']))
    expect(metadata.version).toBe(1)
    expect(metadata.testName).toBe('my test')
    expect(metadata.testStatus).toBe('passed')
    expect(metadata.pilotVersion).toBe('0.1.0')
    expect(metadata.actionCount).toBe(2)
    expect(metadata.device.serial).toBe('emulator-5554')

    // trace.json (NDJSON)
    const traceLines = strFromU8(files['trace.json']).trim().split('\n')
    expect(traceLines).toHaveLength(2)
    const event0 = JSON.parse(traceLines[0])
    expect(event0.type).toBe('action')
    expect(event0.action).toBe('tap')
    expect(event0.actionIndex).toBe(0)
    const event1 = JSON.parse(traceLines[1])
    expect(event1.action).toBe('type')
    expect(event1.actionIndex).toBe(1)
  })

  it('includes source files when configured', () => {
    const config: TraceConfig = {
      mode: 'on',
      screenshots: false,
      snapshots: false,
      sources: true,
      attachments: true,
    }

    // Create a fake source file
    const sourceFile = path.join(tempDir, 'test.ts')
    fs.writeFileSync(sourceFile, 'test("hello", () => {})')

    const collector = new TraceCollector(config, tempDir)

    const zipPath = packageTrace(collector, {
      testFile: 'test.ts',
      testName: 'source test',
      testStatus: 'passed',
      testDuration: 100,
      startTime: 1000,
      endTime: 1100,
      device: { serial: 'test', isEmulator: false },
      pilotVersion: '0.1.0',
      outputDir,
      sourceFiles: [sourceFile],
    })

    const zipData = new Uint8Array(fs.readFileSync(zipPath))
    const files = unzipSync(zipData)
    expect(files['sources/test.ts']).toBeDefined()
    expect(strFromU8(files['sources/test.ts'])).toBe('test("hello", () => {})')
  })

  it('records failed test metadata', () => {
    const config: TraceConfig = {
      mode: 'on',
      screenshots: false,
      snapshots: false,
      sources: false,
      attachments: true,
    }

    const collector = new TraceCollector(config, tempDir)
    collector.addActionEvent({
      category: 'tap',
      action: 'tap',
      duration: 50,
      success: false,
      error: 'Element not found',
      hasScreenshotBefore: false,
      hasScreenshotAfter: false,
      hasHierarchyBefore: false,
      hasHierarchyAfter: false,
    })

    const zipPath = packageTrace(collector, {
      testFile: 'test.ts',
      testName: 'failing test',
      testStatus: 'failed',
      testDuration: 200,
      startTime: 1000,
      endTime: 1200,
      device: { serial: 'test', isEmulator: false },
      pilotVersion: '0.1.0',
      error: 'Element not found',
      outputDir,
    })

    const zipData = new Uint8Array(fs.readFileSync(zipPath))
    const files = unzipSync(zipData)
    const metadata = JSON.parse(strFromU8(files['metadata.json']))
    expect(metadata.testStatus).toBe('failed')
    expect(metadata.error).toBe('Element not found')
  })
})
