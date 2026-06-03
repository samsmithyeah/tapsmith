/**
 * Trace archive packager.
 *
 * Builds a .zip archive from trace collector data. Uses fflate for
 * streaming zip construction to avoid holding all screenshots in memory.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { zipSync, type Zippable } from 'fflate';
import type { TraceCollector, HierarchyCapture } from './trace-collector.js';
import { collectReferencedFiles } from './trace-collector.js';
import type { TraceMetadata, TraceDeviceInfo, NetworkEntry } from './types.js';

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
  /** Tapsmith SDK version. */
  tapsmithVersion: string
  /** Error message if test failed. */
  error?: string
  /** Output directory for the trace zip. */
  outputDir: string
  /** Test source files to include. */
  sourceFiles?: string[]
  /** Captured network entries to include. */
  networkEntries?: NetworkEntry[]
  /** Project name this test belongs to. */
  project?: string
  /** Path to the app state archive restored before this test. */
  appState?: string
}

/**
 * Build a safe filename from a test name.
 */
function safeFileName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 100);
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
  const zipData: Zippable = {};

  // Allocate teardown/finalization time to the last visible action so the
  // action list's wall-clock durations reconcile with metadata.testDuration.
  collector.finalizeTimeline(options.endTime);

  // 1. trace.json — NDJSON event log
  const ndjson = collector.toNDJSON();
  zipData['trace.json'] = new TextEncoder().encode(ndjson);

  // 2. metadata.json
  const metadata: TraceMetadata = {
    version: 1,
    tapsmithVersion: options.tapsmithVersion,
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
      network: collector.config.network,
      deviceLogs: collector.config.deviceLogs,
      daemonLogs: collector.config.daemonLogs,
    },
    actionCount: collector.currentActionIndex,
    screenshotCount: collector.screenshots.length,
    error: options.error,
    project: options.project,
    appState: options.appState,
  };
  zipData['metadata.json'] = new TextEncoder().encode(
    JSON.stringify(metadata, null, 2),
  );

  // 3. Screenshots
  for (const screenshot of collector.screenshots) {
    try {
      const data = fs.readFileSync(screenshot.diskPath);
      zipData[screenshot.archivePath] = new Uint8Array(data);
    } catch {
      // Skip missing screenshots
    }
  }

  // 4. Hierarchy XML snapshots
  for (const hierarchy of collector.hierarchies as HierarchyCapture[]) {
    zipData[hierarchy.archivePath] = new TextEncoder().encode(hierarchy.xml);
  }

  // 5. Source files (optional) — snapshot every file referenced by an action's
  //    stack, keyed by absolute path, so the Source tab shows the exact code
  //    that ran. Capped per file to keep the archive small.
  if (collector.config.sources) {
    const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
    const referenced = new Set<string>();
    if (options.sourceFiles) {
      for (const f of options.sourceFiles) referenced.add(path.resolve(f).replace(/\\/g, '/'));
    }
    for (const f of collectReferencedFiles(collector.events)) referenced.add(path.resolve(f).replace(/\\/g, '/'));
    const sources: Record<string, string> = {};
    for (const sourcePath of referenced) {
      try {
        const stat = fs.statSync(sourcePath);
        if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) continue;
        sources[sourcePath] = fs.readFileSync(sourcePath, 'utf-8');
      } catch {
        // Skip unreadable / missing source files
      }
    }
    if (Object.keys(sources).length > 0) {
      zipData['sources.json'] = new TextEncoder().encode(JSON.stringify(sources));
    }
  }

  // 6. Network entries (optional)
  if (options.networkEntries && options.networkEntries.length > 0) {
    // Write body files into the archive and set paths
    for (const entry of options.networkEntries) {
      if (entry.requestBody && entry.requestBody.length > 0) {
        const bodyPath = `network/req-${entry.index}.bin`;
        zipData[bodyPath] = new Uint8Array(entry.requestBody);
        entry.requestBodyPath = bodyPath;
      }
      if (entry.responseBody && entry.responseBody.length > 0) {
        const bodyPath = `network/res-${entry.index}.bin`;
        zipData[bodyPath] = new Uint8Array(entry.responseBody);
        entry.responseBodyPath = bodyPath;
      }
    }

    // Serialize entries without transient body fields
    const networkNdjson = options.networkEntries
      .map((e) => {
        const { requestBody: _rb, responseBody: _rsb, ...rest } = e;
        return JSON.stringify(rest);
      })
      .join('\n') + '\n';
    zipData['network.json'] = new TextEncoder().encode(networkNdjson);
  }

  // Build zip
  const zipped = zipSync(zipData, { level: 6 });

  // Write to output directory
  fs.mkdirSync(options.outputDir, { recursive: true });
  const safeName = safeFileName(options.testName);
  const projectPrefix = options.project ? `${safeFileName(options.project)}-` : '';
  const zipPath = path.join(options.outputDir, `trace-${projectPrefix}${safeName}-${options.startTime}.zip`);
  fs.writeFileSync(zipPath, zipped);

  // Clean up temporary screenshot files
  for (const screenshot of collector.screenshots) {
    try {
      fs.unlinkSync(screenshot.diskPath);
    } catch {
      // best-effort
    }
  }

  return zipPath;
}
