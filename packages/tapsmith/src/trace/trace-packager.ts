/**
 * Trace archive packager.
 *
 * Builds a .zip archive from trace collector data. Uses fflate for
 * streaming zip construction to avoid holding all screenshots in memory.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { unzipSync, zipSync, type Zippable } from 'fflate';
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
  /** Zero-based attempt number; retries get a `-retryN` filename suffix. */
  retry?: number
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
  // Retries carry their attempt in the name so a flaky test's failed-attempt
  // and retry traces are distinguishable in CI artifacts.
  const retrySuffix = options.retry ? `-retry${options.retry}` : '';
  const zipPath = path.join(options.outputDir, `trace-${projectPrefix}${safeName}${retrySuffix}-${options.startTime}.zip`);
  fs.writeFileSync(zipPath, zipped);

  // Clean up temporary screenshot files. External captures (replayed from a
  // hook collector) are shared with other tests' collectors and cleaned up by
  // their owning collector after the suite — deleting them here would strip
  // hook screenshots from every later test's archive and live stream.
  for (const screenshot of collector.screenshots) {
    if (screenshot.external) continue;
    try {
      fs.unlinkSync(screenshot.diskPath);
    } catch {
      // best-effort
    }
  }

  return zipPath;
}

/**
 * Read the recorded action count from a packaged trace's metadata.json.
 * Used to offset hook collector action indices so appended events don't
 * collide with the archive's existing actions.
 */
export function readTraceActionCount(zipPath: string): number {
  const files = unzipSync(new Uint8Array(fs.readFileSync(zipPath)), {
    filter: (file) => file.name === 'metadata.json',
  });
  if (!files['metadata.json']) return 0;
  const metadata = JSON.parse(new TextDecoder().decode(files['metadata.json'])) as TraceMetadata;
  return typeof metadata.actionCount === 'number' ? metadata.actionCount : 0;
}

/** Shift the action index embedded in a capture archive path (e.g.
 * `screenshots/action-002-before.png` → index+offset). Paths that don't
 * match the action naming scheme are returned unchanged. */
function shiftArchivePath(archivePath: string, offset: number): string {
  return archivePath.replace(
    /action-(\d+)-(before|after)/,
    (_, idx: string, position: string) =>
      `action-${String(parseInt(idx, 10) + offset).padStart(3, '0')}-${position}`,
  );
}

/**
 * Append a hook collector's events to an existing packaged trace archive.
 *
 * Used for afterAll hooks: by the time they run, the last test's trace has
 * already been packaged, so its zip is rewritten in place with the hook
 * events, screenshots, and hierarchy snapshots appended. The collector
 * records with its own zero-based indices (UI mode live-streams those and
 * shifts client-side); `actionIndexOffset` shifts the appended events and
 * capture paths past the archive's existing actions (see
 * {@link readTraceActionCount}) so nothing collides.
 */
export function appendEventsToTrace(
  zipPath: string,
  collector: TraceCollector,
  endTime: number,
  actionIndexOffset = 0,
): void {
  if (collector.events.length === 0) return;
  collector.finalizeTimeline(endTime);

  const files = unzipSync(new Uint8Array(fs.readFileSync(zipPath)));
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const zipData: Zippable = { ...files };

  const shifted = collector.events.map((e) => ({
    ...e,
    actionIndex: e.actionIndex + actionIndexOffset,
  }));
  const appendedNdjson = shifted.map((e) => JSON.stringify(e)).join('\n') + '\n';
  const existing = files['trace.json'] ? decoder.decode(files['trace.json']).trimEnd() : '';
  zipData['trace.json'] = encoder.encode(
    (existing ? existing + '\n' : '') + appendedNdjson,
  );

  if (files['metadata.json']) {
    try {
      const metadata = JSON.parse(decoder.decode(files['metadata.json'])) as TraceMetadata;
      // Guard each field before arithmetic: a missing or malformed value
      // (older/foreign archive) would otherwise produce NaN, which
      // JSON.stringify serializes as null — silently corrupting the
      // metadata and breaking readTraceActionCount on any later append.
      const asNumber = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
      // Only actions move actionCount — a collector holding just console or
      // error events would otherwise bump it by the offset's +1 slack.
      metadata.actionCount = collector.currentActionIndex > 0
        ? Math.max(
          asNumber(metadata.actionCount),
          actionIndexOffset + collector.currentActionIndex,
        )
        : asNumber(metadata.actionCount);
      metadata.endTime = Math.max(asNumber(metadata.endTime), endTime);
      metadata.screenshotCount = asNumber(metadata.screenshotCount) + collector.screenshots.length;
      zipData['metadata.json'] = encoder.encode(JSON.stringify(metadata, null, 2));
    } catch {
      // Unparseable metadata — keep the original.
    }
  }

  for (const screenshot of collector.screenshots) {
    try {
      // Buffer is a Uint8Array — no copy needed for fflate.
      zipData[shiftArchivePath(screenshot.archivePath, actionIndexOffset)] =
        fs.readFileSync(screenshot.diskPath);
    } catch {
      // Skip missing screenshots
    }
  }
  for (const hierarchy of collector.hierarchies) {
    zipData[shiftArchivePath(hierarchy.archivePath, actionIndexOffset)] =
      encoder.encode(hierarchy.xml);
  }

  const zipped = zipSync(zipData, { level: 6 });
  // Write-then-rename so a crash mid-write can't leave a truncated archive.
  const tmpPath = `${zipPath}.tmp`;
  try {
    fs.writeFileSync(tmpPath, zipped);
    fs.renameSync(tmpPath, zipPath);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // best-effort cleanup
    }
    throw err;
  }
}
