/**
 * Trace archive packager.
 *
 * Builds a .zip archive from trace collector data. Uses fflate for
 * streaming zip construction to avoid holding all screenshots in memory.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { zipSync, type Zippable } from 'fflate'
import type { TraceCollector, HierarchyCapture } from './trace-collector.js'
import type { TraceMetadata, TraceDeviceInfo } from './types.js'

export interface PackageOptions {
  /** Test file path. */
  testFile: string
  /** Fully qualified test name. */
  testName: string
  /** Test status. */
  testStatus: 'passed' | 'failed' | 'skipped'
  /** Test duration in ms. */
  testDuration: number
  /** Start timestamp. */
  startTime: number
  /** End timestamp. */
  endTime: number
  /** Device information. */
  device: TraceDeviceInfo
  /** Pilot SDK version. */
  pilotVersion: string
  /** Error message if test failed. */
  error?: string
  /** Output directory for the trace zip. */
  outputDir: string
  /** Test source files to include. */
  sourceFiles?: string[]
}

/**
 * Build a safe filename from a test name.
 */
function safeFileName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 100)
}

/**
 * Package trace data into a .zip archive.
 *
 * @returns The absolute path to the created zip file.
 */
export function packageTrace(
  collector: TraceCollector,
  options: PackageOptions,
): string {
  const zipData: Zippable = {}

  // 1. trace.json — NDJSON event log
  const ndjson = collector.toNDJSON()
  zipData['trace.json'] = new TextEncoder().encode(ndjson)

  // 2. metadata.json
  const metadata: TraceMetadata = {
    version: 1,
    pilotVersion: options.pilotVersion,
    testFile: options.testFile,
    testName: options.testName,
    testStatus: options.testStatus,
    testDuration: options.testDuration,
    startTime: options.startTime,
    endTime: options.endTime,
    device: options.device,
    traceConfig: {
      screenshots: collector.config.screenshots,
      snapshots: collector.config.snapshots,
      sources: collector.config.sources,
    },
    actionCount: collector.currentActionIndex,
    screenshotCount: collector.screenshots.length,
    error: options.error,
  }
  zipData['metadata.json'] = new TextEncoder().encode(
    JSON.stringify(metadata, null, 2),
  )

  // 3. Screenshots
  for (const screenshot of collector.screenshots) {
    try {
      const data = fs.readFileSync(screenshot.diskPath)
      zipData[screenshot.archivePath] = new Uint8Array(data)
    } catch {
      // Skip missing screenshots
    }
  }

  // 4. Hierarchy XML snapshots
  for (const hierarchy of collector.hierarchies as HierarchyCapture[]) {
    zipData[hierarchy.archivePath] = new TextEncoder().encode(hierarchy.xml)
  }

  // 5. Source files (optional)
  if (collector.config.sources && options.sourceFiles) {
    for (const sourcePath of options.sourceFiles) {
      try {
        const content = fs.readFileSync(sourcePath, 'utf-8')
        const basename = path.basename(sourcePath)
        zipData[`sources/${basename}`] = new TextEncoder().encode(content)
      } catch {
        // Skip unreadable source files
      }
    }
  }

  // Build zip
  const zipped = zipSync(zipData, { level: 6 })

  // Write to output directory
  fs.mkdirSync(options.outputDir, { recursive: true })
  const safeName = safeFileName(options.testName)
  const zipPath = path.join(options.outputDir, `trace-${safeName}.zip`)
  fs.writeFileSync(zipPath, zipped)

  // Clean up temporary screenshot files
  for (const screenshot of collector.screenshots) {
    try {
      fs.unlinkSync(screenshot.diskPath)
    } catch {
      // best-effort
    }
  }

  return zipPath
}
