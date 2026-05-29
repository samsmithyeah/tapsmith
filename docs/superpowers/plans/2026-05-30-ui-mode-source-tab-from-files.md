# UI Mode Source Tab — Read From Actual Source Files — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Source tab (UI mode + offline trace viewer) show the actual file each action originated from — test file, helper, page object, or fixture — read from a run-time snapshot, with a clickable call-stack pane, matching Playwright.

**Architecture:** Capture the full filtered call stack per action/assertion in the SDK (pure TypeScript — `new Error().stack` is already taken at every site). Snapshot every referenced file at run time, keyed by absolute path: streamed over WebSocket for live UI mode, embedded as `sources.json` in the trace zip for the offline viewer. The shared `SourceTab` component renders the file for the selected stack frame, defaulting to the action's own (top) frame, with a stack pane shown when there is more than one frame. Disk is used only for the pre-run preview (the existing test-file send).

**Tech Stack:** TypeScript (Node16 ESM, no semicolons, strict), Preact (UI mode + trace viewer), Vitest (Node env — no DOM/testing-library), fflate (zip), CSS-in-JS (`ui-mode.css.ts`). Reference spec: `docs/superpowers/specs/2026-05-30-ui-mode-source-tab-design.md`.

---

## File Structure

**SDK — capture & snapshot**
- `packages/tapsmith/src/trace/trace-collector.ts` — add `extractStack()` and `collectReferencedFiles()`; `extractSourceLocation()` becomes `extractStack()[0]`.
- `packages/tapsmith/src/trace/types.ts` — add `stack?: SourceLocation[]` to `ActionTraceEvent` and `AssertionTraceEvent`.
- `packages/tapsmith/src/trace/traced-action.ts` — thread `stack` into the three emitted events.
- `packages/tapsmith/src/element-handle.ts`, `device.ts`, `expect.ts`, `network.ts`, `api-request.ts`, `webview-handle.ts` — thread `stack` at each capture site (mechanical, same pattern).

**SDK — offline persistence**
- `packages/tapsmith/src/trace/trace-packager.ts` — write `sources.json` (absolute-path-keyed) from referenced files, with size cap.

**Live transport**
- `packages/tapsmith/src/ui-mode/source-stream.ts` — NEW shared helper that reads & emits a file once per referenced path.
- `packages/tapsmith/src/ui-mode/ui-protocol.ts` — add `path` to `SourceMessage` and to the two child source-message types.
- `packages/tapsmith/src/ui-mode/ui-run.ts`, `ui-worker.ts` — stream referenced-file sources; add `path` to the test-file send.
- `packages/tapsmith/src/ui-mode/ui-server.ts` — key the source buffer by `path`; carry `path` through the two `source` cases.

**Frontend**
- `packages/tapsmith/src/trace-viewer/main.tsx` — load `sources.json` into the absolute-path-keyed `sources` map.
- `packages/tapsmith/src/ui-mode/main.tsx` — key the client source pool/injection by `path`.
- `packages/tapsmith/src/trace-viewer/components/DetailTabs.tsx` — rewrite `SourceTab`, add `StackTraceView` and the pure `resolveSourceView()`.
- `packages/tapsmith/src/ui-mode/styles/ui-mode.css.ts` — stack-pane styles.

**Tests**
- `packages/tapsmith/src/__tests__/trace-collector.test.ts` — `extractStack`, `collectReferencedFiles`, `addActionEvent` preserves `stack`.
- `packages/tapsmith/src/__tests__/source-view.test.ts` — NEW, `resolveSourceView`.
- `packages/tapsmith/src/__tests__/trace-packager.test.ts` — NEW or existing, `sources.json` round-trip.

**Commands** (run from `packages/tapsmith/`): `npm run typecheck`, `npm run lint`, `npm run test`, `npm run knip`. The web apps are built/typechecked separately in CI; `npm run build` builds the SDK.

---

## Task 1: `extractStack` — capture the full filtered call stack

**Files:**
- Modify: `packages/tapsmith/src/trace/trace-collector.ts:106-131`
- Test: `packages/tapsmith/src/__tests__/trace-collector.test.ts` (existing `describe('extractSourceLocation')` near line 492)

- [ ] **Step 1: Write failing tests for `extractStack`**

Add to `trace-collector.test.ts` (and add `extractStack` to the import on line 5):

```ts
describe('extractStack', () => {
  it('returns all user-code frames in order, top first', () => {
    const stack = [
      'Error',
      '    at Object.tap (/proj/node_modules/tapsmith/dist/element-handle.js:10:5)',
      '    at loginHelper (/proj/tests/helpers/login.ts:8:3)',
      '    at /proj/tests/auth.test.ts:42:7',
    ].join('\n')
    const frames = extractStack(stack)
    expect(frames).toEqual([
      { file: '/proj/tests/helpers/login.ts', line: 8, column: 3 },
      { file: '/proj/tests/auth.test.ts', line: 42, column: 7 },
    ])
  })

  it('filters SDK, node_modules, and node internal frames', () => {
    const stack = [
      'Error',
      '    at /proj/packages/tapsmith/src/device.ts:700:1',
      '    at node:internal/process/task_queues:95:5',
      '    at internal/main/run_main_module:23:47',
      '    at /proj/tests/x.test.ts:3:1',
    ].join('\n')
    expect(extractStack(stack)).toEqual([{ file: '/proj/tests/x.test.ts', line: 3, column: 1 }])
  })

  it('extractSourceLocation returns the first frame from extractStack', () => {
    const stack = 'Error\n    at /proj/a.ts:1:2\n    at /proj/b.ts:3:4'
    expect(extractSourceLocation(stack)).toEqual(extractStack(stack)[0])
  })

  it('returns [] for an empty stack', () => {
    expect(extractStack('')).toEqual([])
  })
})
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm run test -- trace-collector` (from `packages/tapsmith/`)
Expected: FAIL — `extractStack is not a function` / import error.

- [ ] **Step 3: Implement `extractStack`, refactor `extractSourceLocation`**

Replace `trace-collector.ts:110-131` (the existing `extractSourceLocation` body) with:

```ts
/**
 * Extract all user-code frames from a stack trace, top frame first.
 * Skips frames inside the tapsmith SDK, node_modules, and node internals.
 */
export function extractStack(stack: string): SourceLocation[] {
  const frames: SourceLocation[] = []
  for (const line of stack.split('\n')) {
    const match = STACK_FRAME_RE.exec(line.trim())
    if (!match) continue
    const file = match[1]
    if (file.includes('/tapsmith/src/') || file.includes('/tapsmith/dist/')) continue
    if (file.includes('node_modules')) continue
    if (file.startsWith('node:') || file.startsWith('internal/')) continue
    frames.push({ file, line: parseInt(match[2], 10), column: parseInt(match[3], 10) })
  }
  return frames
}

/**
 * Extract the caller's source location (the top user-code frame) from a stack
 * trace. Convenience wrapper over {@link extractStack}.
 */
export function extractSourceLocation(stack: string): SourceLocation | undefined {
  return extractStack(stack)[0]
}
```

Leave `STACK_FRAME_RE` (line 108) unchanged.

- [ ] **Step 4: Run tests, verify they pass**

Run: `npm run test -- trace-collector`
Expected: PASS (new `extractStack` tests + existing `extractSourceLocation` tests).

- [ ] **Step 5: Commit**

```bash
git add packages/tapsmith/src/trace/trace-collector.ts packages/tapsmith/src/__tests__/trace-collector.test.ts
git commit -m "Add extractStack to capture full filtered call stack"
```

---

## Task 2: Add `stack` field to action/assertion trace events

**Files:**
- Modify: `packages/tapsmith/src/trace/types.ts:111-112` and `:160-161`

- [ ] **Step 1: Add the field to `ActionTraceEvent`**

In `types.ts`, directly after the existing `sourceLocation?: SourceLocation` (line 111-112), add:

```ts
  /** Full user-code call stack at the time of the action (top frame first).
   * `sourceLocation` is `stack[0]`. */
  stack?: SourceLocation[]
```

- [ ] **Step 2: Add the field to `AssertionTraceEvent`**

In `types.ts`, directly after the assertion's `sourceLocation?: SourceLocation` (line 160-161), add the identical block:

```ts
  /** Full user-code call stack at the time of the assertion (top frame first).
   * `sourceLocation` is `stack[0]`. */
  stack?: SourceLocation[]
```

- [ ] **Step 3: Verify it type-checks**

Run: `npm run typecheck`
Expected: PASS (field is optional; no existing code breaks).

- [ ] **Step 4: Commit**

```bash
git add packages/tapsmith/src/trace/types.ts
git commit -m "Add stack[] field to action and assertion trace events"
```

---

## Task 3: Thread `stack` through `traced-action.ts`

**Files:**
- Modify: `packages/tapsmith/src/trace/traced-action.ts:10,45,89-94,108-118,157-166`
- Test: `packages/tapsmith/src/__tests__/trace-collector.test.ts`

- [ ] **Step 1: Write a failing test that an action event carries `stack`**

Add to `trace-collector.test.ts`:

```ts
describe('addActionEvent preserves stack', () => {
  it('keeps the stack array on the emitted event', () => {
    const c = new TraceCollector({ screenshots: false, snapshots: false, sources: true, network: false, deviceLogs: false }, '/tmp/ts-test-' + process.pid)
    c.addActionEvent({
      category: 'tap', action: 'tap', duration: 1, success: true,
      hasScreenshotBefore: false, hasScreenshotAfter: false,
      hasHierarchyBefore: false, hasHierarchyAfter: false,
      sourceLocation: { file: '/p/a.ts', line: 1 },
      stack: [{ file: '/p/a.ts', line: 1 }, { file: '/p/b.ts', line: 2 }],
    })
    const ev = c.events.find(e => e.type === 'action') as ActionTraceEvent
    expect(ev.stack).toEqual([{ file: '/p/a.ts', line: 1 }, { file: '/p/b.ts', line: 2 }])
  })
})
```

(Add `ActionTraceEvent` to the test's type imports if not present.)

- [ ] **Step 2: Run test, verify it fails**

Run: `npm run test -- trace-collector`
Expected: FAIL — `ev.stack` is `undefined` (the field exists in the type but no value is threaded; this test fails only if Task 3 implementation is absent — it actually passes already since `addActionEvent` spreads `...event`). If it PASSES immediately, that confirms `addActionEvent` already forwards `stack` via the spread; keep the test as a regression guard and proceed to Step 3 for the capture wiring.

- [ ] **Step 3: Capture and emit `stack` in `tracedAction`**

In `traced-action.ts`:

1. Line 10 — change the import:
```ts
import { extractStack } from './trace-collector.js';
```

2. Line 45 — replace:
```ts
  const sourceLocation = extractSourceLocation(new Error().stack ?? '');
```
with:
```ts
  const stack = extractStack(new Error().stack ?? '');
  const sourceLocation = stack[0];
```

3. In the `_emitActionStarted({ ... })` call (lines 89-94), add `stack,` next to `sourceLocation`:
```ts
  ctx.collector._emitActionStarted({
    category, action, selector: selectorStr, inputValue: extra?.inputValue,
    bounds, point, sourceLocation, stack, log: [...log],
    hasScreenshotBefore: !!beforeCaptures.screenshotBefore,
    hasHierarchyBefore: !!beforeCaptures.hierarchyBefore,
  });
```

4. In the timeout-handler `addActionEvent({ ... })` (lines 108-117), add `stack,` next to `sourceLocation` (line 116):
```ts
      hasHierarchyAfter: false,
      sourceLocation, stack,
    });
```

5. In the final `addActionEvent({ ... })` (lines 157-166), add `stack,` next to `sourceLocation` (line 165):
```ts
    hasHierarchyAfter: false,
    sourceLocation, stack,
  });
```

- [ ] **Step 4: Run typecheck + tests**

Run: `npm run typecheck && npm run test -- trace-collector`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/tapsmith/src/trace/traced-action.ts packages/tapsmith/src/__tests__/trace-collector.test.ts
git commit -m "Capture and emit full stack from tracedAction"
```

---

## Task 4: Thread `stack` through the remaining capture sites

Every remaining site follows the **exact same transformation** as Task 3 Step 3 (items 1-2): replace the single `extractSourceLocation(new Error().stack ?? '')` with `extractStack(...)` + `stack[0]`, then add `stack` to the event object emitted at that site.

**The transformation at each site:**
1. Ensure the file imports `extractStack` (replace or extend the existing `extractSourceLocation` import from `./trace/trace-collector.js` / `../trace/trace-collector.js`).
2. Replace:
   ```ts
   const sourceLocation = extractSourceLocation(new Error().stack ?? '')
   ```
   with:
   ```ts
   const stack = extractStack(new Error().stack ?? '')
   const sourceLocation = stack[0]
   ```
   (For sites named `source` instead of `sourceLocation` — e.g. `device.ts:730,750,759` — keep that local name: `const source = stack[0]`.)
3. In the trace event emitted using that location (the nearby `addActionEvent` / `addAssertionEvent` / `_emitAssertionStarted` / event object literal), add `stack` alongside the existing `sourceLocation` field. For the `expect.ts:1219` inline form `sourceLocation: extractSourceLocation(...)`, change to compute `stack` just above and pass both `sourceLocation: stack[0], stack`.

**Files:**
- Modify: `packages/tapsmith/src/expect.ts:23,292,1219,1662`
- Modify: `packages/tapsmith/src/element-handle.ts:25,781,800,829`
- Modify: `packages/tapsmith/src/device.ts:33,730,750,759,883`
- Modify: `packages/tapsmith/src/network.ts:13,531`
- Modify: `packages/tapsmith/src/api-request.ts:12,157`
- Modify: `packages/tapsmith/src/webview-handle.ts:5,162`

- [ ] **Step 1: Apply the transformation in `expect.ts`** (3 sites: 292, 1219, 1662). For each, after computing `stack`, add `stack` to the corresponding `addAssertionEvent`/`_emitAssertionStarted`/event object.

- [ ] **Step 2: Apply the transformation in `element-handle.ts`** (3 sites: 781, 800, 829), adding `stack` to each emitted query/action event.

- [ ] **Step 3: Apply the transformation in `device.ts`** (4 sites: 730, 750, 759, 883), adding `stack` to each emitted event. Note sites 730/750/759 use the local name `source`; set `const source = stack[0]` and add `stack` to the event.

- [ ] **Step 4: Apply the transformation in `network.ts` (531), `api-request.ts` (157), and `webview-handle.ts` (162)**, adding `stack` to each emitted event.

- [ ] **Step 5: Run typecheck, lint, and the full unit suite**

Run: `npm run typecheck && npm run lint && npm run test`
Expected: PASS. (No behavior change yet beyond events carrying `stack`.)

- [ ] **Step 6: Commit**

```bash
git add packages/tapsmith/src/expect.ts packages/tapsmith/src/element-handle.ts packages/tapsmith/src/device.ts packages/tapsmith/src/network.ts packages/tapsmith/src/api-request.ts packages/tapsmith/src/webview-handle.ts
git commit -m "Capture full stack at all trace event sites"
```

---

## Task 5: `collectReferencedFiles` helper

**Files:**
- Modify: `packages/tapsmith/src/trace/trace-collector.ts` (add exported function near `extractStack`)
- Test: `packages/tapsmith/src/__tests__/trace-collector.test.ts`

- [ ] **Step 1: Write a failing test**

```ts
describe('collectReferencedFiles', () => {
  it('returns the unique set of files across action and assertion stacks', () => {
    const events = [
      { type: 'action', stack: [{ file: '/p/a.ts', line: 1 }, { file: '/p/h.ts', line: 2 }] },
      { type: 'assertion', stack: [{ file: '/p/h.ts', line: 9 }] },
      { type: 'console' },
      { type: 'action' }, // no stack
    ] as unknown as AnyTraceEvent[]
    expect(collectReferencedFiles(events).sort()).toEqual(['/p/a.ts', '/p/h.ts'])
  })
})
```

(Import `collectReferencedFiles` and `AnyTraceEvent`.)

- [ ] **Step 2: Run, verify it fails**

Run: `npm run test -- trace-collector`
Expected: FAIL — not a function.

- [ ] **Step 3: Implement it** (add directly after `extractSourceLocation` in `trace-collector.ts`; ensure `AnyTraceEvent` is imported in that file — it already is, used by the collector):

```ts
/**
 * Collect the unique set of absolute file paths referenced by the stacks of all
 * action/assertion events. Used to snapshot exactly the source files the trace
 * can display.
 */
export function collectReferencedFiles(events: readonly AnyTraceEvent[]): string[] {
  const files = new Set<string>()
  for (const ev of events) {
    if ((ev.type === 'action' || ev.type === 'assertion') && ev.stack) {
      for (const frame of ev.stack) files.add(frame.file)
    }
  }
  return [...files]
}
```

- [ ] **Step 4: Run, verify it passes**

Run: `npm run test -- trace-collector`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/tapsmith/src/trace/trace-collector.ts packages/tapsmith/src/__tests__/trace-collector.test.ts
git commit -m "Add collectReferencedFiles helper"
```

---

## Task 6: Embed `sources.json` in the trace archive (offline)

**Files:**
- Modify: `packages/tapsmith/src/trace/trace-packager.ts:1-12 (imports), 117-128 (sources block)`
- Test: `packages/tapsmith/src/__tests__/trace-packager.test.ts` (create if absent)

- [ ] **Step 1: Write a failing round-trip test**

Create/extend `trace-packager.test.ts`. Use a real temp file as a source so the packager can read it:

```ts
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { unzipSync } from 'fflate'
import { TraceCollector } from '../trace/trace-collector.js'
import { packageTrace } from '../trace/trace-packager.js'

describe('packageTrace sources.json', () => {
  it('writes referenced source files keyed by absolute path', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-pkg-'))
    const srcFile = path.join(tmp, 'helper.ts')
    fs.writeFileSync(srcFile, 'export const x = 1\n')

    const c = new TraceCollector({ screenshots: false, snapshots: false, sources: true, network: false, deviceLogs: false }, tmp)
    c.addActionEvent({
      category: 'tap', action: 'tap', duration: 1, success: true,
      hasScreenshotBefore: false, hasScreenshotAfter: false,
      hasHierarchyBefore: false, hasHierarchyAfter: false,
      sourceLocation: { file: srcFile, line: 1 }, stack: [{ file: srcFile, line: 1 }],
    })

    const zipPath = packageTrace(c, {
      testFile: srcFile, testName: 't', testStatus: 'passed', testDuration: 1,
      startTime: 1, endTime: 2, device: { platform: 'android' } as never,
      tapsmithVersion: '0.0.0', outputDir: tmp, sourceFiles: [srcFile],
    })

    const files = unzipSync(new Uint8Array(fs.readFileSync(zipPath)))
    const sources = JSON.parse(new TextDecoder().decode(files['sources.json']))
    expect(sources[srcFile]).toBe('export const x = 1\n')
  })
})
```

(If `device` shape causes a type error, build it via the same helper the existing tests use, or cast as shown.)

- [ ] **Step 2: Run, verify it fails**

Run: `npm run test -- trace-packager`
Expected: FAIL — `files['sources.json']` is `undefined` (today only `sources/<basename>` is written).

- [ ] **Step 3: Replace the sources block** at `trace-packager.ts:117-128`:

```ts
  // 5. Source files (optional) — snapshot every file referenced by an action's
  //    stack, keyed by absolute path, so the Source tab shows the exact code
  //    that ran. Capped per file to keep the archive small.
  if (collector.config.sources) {
    const MAX_SOURCE_BYTES = 2 * 1024 * 1024
    const referenced = new Set<string>(options.sourceFiles ?? [])
    for (const f of collectReferencedFiles(collector.events)) referenced.add(f)
    const sources: Record<string, string> = {}
    for (const sourcePath of referenced) {
      try {
        if (fs.statSync(sourcePath).size > MAX_SOURCE_BYTES) continue
        sources[sourcePath] = fs.readFileSync(sourcePath, 'utf-8')
      } catch {
        // Skip unreadable / missing source files
      }
    }
    if (Object.keys(sources).length > 0) {
      zipData['sources.json'] = new TextEncoder().encode(JSON.stringify(sources))
    }
  }
```

Add the import at the top of `trace-packager.ts` (extend the existing `./trace-collector.js` import or add one):

```ts
import { collectReferencedFiles } from './trace-collector.js'
```

- [ ] **Step 4: Run, verify it passes**

Run: `npm run test -- trace-packager`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/tapsmith/src/trace/trace-packager.ts packages/tapsmith/src/__tests__/trace-packager.test.ts
git commit -m "Embed referenced source files as sources.json in trace archive"
```

---

## Task 7: Load `sources.json` in the offline trace viewer

**Files:**
- Modify: `packages/tapsmith/src/trace-viewer/main.tsx:101-106`

- [ ] **Step 1: Replace the sources-loading block** (`parseTraceZip`, lines 101-106):

```ts
  const sources = new Map<string, string>();
  const sourcesRaw = files["sources.json"];
  if (sourcesRaw) {
    try {
      const parsed = JSON.parse(decoder.decode(sourcesRaw)) as Record<string, string>;
      for (const [p, content] of Object.entries(parsed)) sources.set(p, content);
    } catch {
      // Ignore malformed sources.json — Source tab will show "not captured".
    }
  }
```

This keeps the `sources` map type (`Map<string, string>`) but the keys are now absolute paths. `buildCodeFrame` (`DetailTabs.tsx:553`) already tries `sources.get(loc.file)` first, so it keeps working.

- [ ] **Step 2: Verify it type-checks**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/tapsmith/src/trace-viewer/main.tsx
git commit -m "Load sources.json (path-keyed) in offline trace viewer"
```

---

## Task 8: Add `path` to the source WebSocket/IPC messages

**Files:**
- Modify: `packages/tapsmith/src/ui-mode/ui-protocol.ts:214-218` (`SourceMessage`, server→client), `:483-487` (`UIRunSourceMessage`, child→server), `:612-617` (`UIWorkerSourceMessage`, child→server, has `workerId`).
- Modify: `packages/tapsmith/src/ui-mode/ui-server.ts:1088-1096, 1855-1858, 219, 3211-3213`

- [ ] **Step 1: Add `path` to `SourceMessage`** (lines 214-218):

```ts
export interface SourceMessage {
  type: 'source'
  /** Absolute path of the source file — unique key for the client sources map. */
  path: string
  /** Basename for display. */
  fileName: string
  content: string
}
```

- [ ] **Step 2: Add `path` to the two child source-message types.**

`UIRunSourceMessage` (lines 483-487):
```ts
export interface UIRunSourceMessage {
  type: 'source'
  path: string
  fileName: string
  content: string
}
```

`UIWorkerSourceMessage` (lines 612-617):
```ts
export interface UIWorkerSourceMessage {
  type: 'source'
  workerId: number
  path: string
  fileName: string
  content: string
}
```

- [ ] **Step 3: Carry `path` through the server's two `source` cases.**

`ui-server.ts:1088-1096` (single-run path):
```ts
          case 'source': {
            const sourceMsg: SourceMessage = {
              type: 'source',
              path: response.path,
              fileName: response.fileName,
              content: response.content,
            };
            sourceBuffer.set(response.path, sourceMsg);
            broadcast(sourceMsg);
            break;
          }
```

`ui-server.ts:1855-1858` (worker path):
```ts
            case 'source': {
              const sourceMsg: SourceMessage = { type: 'source', path: msg.path, fileName: msg.fileName, content: msg.content };
              sourceBuffer.set(msg.path, sourceMsg);
              broadcast(sourceMsg);
```

The `sourceBuffer` declaration (line 219) stays `Map<string, SourceMessage>` — it is now keyed by path. The reconnect replay (3211-3213) is unchanged (iterates `.values()`).

- [ ] **Step 4: Verify type-check** (will fail until Task 9 sets `path` on the sends — that's expected; run after Task 9).

Run: `npm run typecheck`
Expected: errors only about missing `path` on the `send({ type: 'source', ... })` calls in `ui-run.ts`/`ui-worker.ts` — fixed in Task 9.

- [ ] **Step 5: Commit**

```bash
git add packages/tapsmith/src/ui-mode/ui-protocol.ts packages/tapsmith/src/ui-mode/ui-server.ts
git commit -m "Add absolute path to source messages; key source buffer by path"
```

---

## Task 9: Stream referenced source files live

**Files:**
- Create: `packages/tapsmith/src/ui-mode/source-stream.ts`
- Modify: `packages/tapsmith/src/ui-mode/ui-run.ts:100-116 (setupTraceStreaming), 153-159 (test-file send)`
- Modify: `packages/tapsmith/src/ui-mode/ui-worker.ts:118-132 (event callback), 320-327 (test-file send)`
- Test: `packages/tapsmith/src/__tests__/source-stream.test.ts`

- [ ] **Step 1: Write a failing test for the shared helper**

`source-stream.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { streamSourcesForEvent } from '../ui-mode/source-stream.js'
import type { AnyTraceEvent } from '../trace/types.js'

describe('streamSourcesForEvent', () => {
  it('reads and emits each referenced file once', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-ss-'))
    const f = path.join(tmp, 'a.ts')
    fs.writeFileSync(f, 'const a = 1\n')
    const sent = new Set<string>()
    const emitted: Array<{ path: string; fileName: string; content: string }> = []
    const emit = (p: string, fn: string, content: string) => emitted.push({ path: p, fileName: fn, content })
    const ev = { type: 'action', stack: [{ file: f, line: 1 }, { file: f, line: 2 }] } as unknown as AnyTraceEvent
    streamSourcesForEvent(ev, sent, emit)
    streamSourcesForEvent(ev, sent, emit) // second call: already sent
    expect(emitted).toEqual([{ path: f, fileName: 'a.ts', content: 'const a = 1\n' }])
  })

  it('ignores events without a stack and missing files', () => {
    const sent = new Set<string>()
    let calls = 0
    streamSourcesForEvent({ type: 'console' } as unknown as AnyTraceEvent, sent, () => calls++)
    streamSourcesForEvent({ type: 'action', stack: [{ file: '/no/such/file.ts', line: 1 }] } as unknown as AnyTraceEvent, sent, () => calls++)
    expect(calls).toBe(0)
  })
})
```

- [ ] **Step 2: Run, verify it fails**

Run: `npm run test -- source-stream`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `source-stream.ts`**

```ts
/**
 * Shared helper for UI mode child processes (single-run + worker) to stream the
 * source files referenced by a trace event's stack. Files are read from disk
 * once per absolute path and emitted so the Source tab can display the exact
 * code that ran.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { AnyTraceEvent } from '../trace/types.js'

const MAX_SOURCE_BYTES = 2 * 1024 * 1024

export function streamSourcesForEvent(
  event: AnyTraceEvent,
  sent: Set<string>,
  emit: (filePath: string, fileName: string, content: string) => void,
): void {
  if (event.type !== 'action' && event.type !== 'assertion') return
  if (!event.stack) return
  for (const frame of event.stack) {
    if (sent.has(frame.file)) continue
    sent.add(frame.file)
    try {
      if (fs.statSync(frame.file).size > MAX_SOURCE_BYTES) continue
      const content = fs.readFileSync(frame.file, 'utf-8')
      emit(frame.file, path.basename(frame.file), content)
    } catch {
      // best-effort — file may be unreadable or transient
    }
  }
}
```

- [ ] **Step 4: Run, verify it passes**

Run: `npm run test -- source-stream`
Expected: PASS.

- [ ] **Step 5: Wire into `ui-run.ts`**

Add import at top: `import { streamSourcesForEvent } from './source-stream.js'`.

Rewrite `setupTraceStreaming` (lines 100-116) to stream sources before forwarding each event:
```ts
function setupTraceStreaming(device: Device): void {
  const collector = device.tracing._currentCollector;
  if (!collector) return;

  const sentSources = new Set<string>();
  collector.setEventCallback((event: AnyTraceEvent, screenshots, lifecycle) => {
    streamSourcesForEvent(event, sentSources, (p, fileName, content) =>
      send({ type: 'source', path: p, fileName, content }));
    const msg: UIRunTraceEventMessage = {
      type: 'trace-event',
      event,
      lifecycle,
      screenshotBefore: screenshots?.before?.toString('base64'),
      screenshotAfter: screenshots?.after?.toString('base64'),
      hierarchyBefore: screenshots?.hierarchyBefore,
      hierarchyAfter: screenshots?.hierarchyAfter,
    };
    send(msg);
  });
}
```

Update the test-file send (line 156) to include `path` (pre-run preview):
```ts
    send({ type: 'source', path: msg.filePath, fileName: path.basename(msg.filePath), content: sourceContent });
```

- [ ] **Step 6: Wire into `ui-worker.ts`**

Add import: `import { streamSourcesForEvent } from './source-stream.js'`.

In the event callback (lines 119-131), add a `sentSources` set in the enclosing scope (alongside where `collector.setEventCallback` is set up — declare `const sentSources = new Set<string>()` just before it) and stream before `send(msg)`:
```ts
    streamSourcesForEvent(event, sentSources, (p, fileName, content) =>
      send({ type: 'source', workerId, path: p, fileName, content }));
```

Update the worker's test-file send (line 327) to include `path`:
```ts
    send({ type: 'source', workerId, path: filePath, fileName: path.basename(filePath), content: sourceContent });
```

- [ ] **Step 7: Run typecheck + tests** (this also resolves the Task 8 Step 4 type errors)

Run: `npm run typecheck && npm run test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/tapsmith/src/ui-mode/source-stream.ts packages/tapsmith/src/ui-mode/ui-run.ts packages/tapsmith/src/ui-mode/ui-worker.ts packages/tapsmith/src/__tests__/source-stream.test.ts
git commit -m "Stream referenced source files live in UI mode"
```

---

## Task 10: Key the client source pool by path (UI mode)

**Files:**
- Modify: `packages/tapsmith/src/ui-mode/main.tsx:544-549 (test-start snapshot), 738-756 (source handler)`

- [ ] **Step 1: Update the test-start snapshot** (lines 544-549) to key by path. The pending pool is now keyed by absolute path; the test file's key is `msg.filePath`:

```ts
          // Seed the test file from the pending pool (pre-run preview).
          const sourceContent = pendingSourcesRef.current.get(msg.filePath);
          if (sourceContent) {
            data.sources = new Map([[msg.filePath, sourceContent]]);
          }
```

(Remove the now-unused `const basename = msg.filePath.split('/').pop() ?? ''` line.)

- [ ] **Step 2: Update the `source` handler** (lines 738-756) to key by `msg.path` and inject into the active (running) test, falling back to all entries on reconnect (no active test):

```ts
      case 'source':
        pendingSourcesRef.current.set(msg.path, msg.content);
        setTestTraces((prev) => {
          let changed = false;
          const next = new Map(prev);
          for (const [k, data] of prev) {
            if (data.sources.has(msg.path)) continue;
            // During a run, attribute sources to the active test. On reconnect
            // replay (no active test) inject into every entry so files resolve.
            if (activeTestRef.current === k || activeTestRef.current === null) {
              next.set(k, { ...data, sources: new Map([...data.sources, [msg.path, msg.content]]) });
              changed = true;
            }
          }
          return changed ? next : prev;
        });
        break;
```

- [ ] **Step 3: Verify type-check**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/tapsmith/src/ui-mode/main.tsx
git commit -m "Key UI mode client source pool by absolute path"
```

---

## Task 11: Rewrite `SourceTab` with a stack pane

**Files:**
- Modify: `packages/tapsmith/src/trace-viewer/components/DetailTabs.tsx:1-10 (imports), 469-520 (SourceTab)`
- Create (export): `resolveSourceView` in `DetailTabs.tsx` (exported for testing)
- Modify: `packages/tapsmith/src/ui-mode/styles/ui-mode.css.ts` (add stack-pane styles)
- Test: `packages/tapsmith/src/__tests__/source-view.test.ts`

- [ ] **Step 1: Write failing tests for `resolveSourceView`**

`source-view.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { resolveSourceView } from '../trace-viewer/components/DetailTabs.js'
import type { SourceLocation } from '../trace/types.js'

const stack: SourceLocation[] = [{ file: '/p/a.ts', line: 5 }, { file: '/p/h.ts', line: 9 }]

describe('resolveSourceView', () => {
  it('shows the selected frame file + line when captured', () => {
    const sources = new Map([['/p/a.ts', 'A'], ['/p/h.ts', 'H']])
    expect(resolveSourceView(stack, sources, 1, true)).toEqual({ filename: '/p/h.ts', content: 'H', highlightLine: 9 })
  })
  it('falls back to first file with no highlight pre-run (no event)', () => {
    const sources = new Map([['/p/test.ts', 'T']])
    expect(resolveSourceView([], sources, 0, false)).toEqual({ filename: '/p/test.ts', content: 'T' })
  })
  it('reports filename without content when frame not captured', () => {
    expect(resolveSourceView(stack, new Map(), 0, true)).toEqual({ filename: '/p/a.ts' })
  })
  it('returns empty when nothing available', () => {
    expect(resolveSourceView([], new Map(), 0, true)).toEqual({})
  })
})
```

- [ ] **Step 2: Run, verify it fails**

Run: `npm run test -- source-view`
Expected: FAIL — `resolveSourceView` not exported.

- [ ] **Step 3: Add `SourceLocation` to the type import** in `DetailTabs.tsx` line 6 (extend the existing `import type { ... } from '../../trace/types.js'` to include `SourceLocation`).

- [ ] **Step 4: Replace the `SourceTab` function** (lines 469-520) with the resolver + new component + stack pane:

```tsx
export function resolveSourceView(
  stack: SourceLocation[],
  sources: Map<string, string>,
  selectedFrame: number,
  hasEvent: boolean,
): { filename?: string; content?: string; highlightLine?: number } {
  const frame = stack[selectedFrame];
  if (frame && sources.has(frame.file)) {
    return { filename: frame.file, content: sources.get(frame.file), highlightLine: frame.line };
  }
  if (!hasEvent && sources.size > 0) {
    const [filename, content] = [...sources.entries()][0];
    return { filename, content };
  }
  if (frame) return { filename: frame.file };
  return {};
}

function StackTraceView({ stack, selected, onSelect }: { stack: SourceLocation[]; selected: number; onSelect: (i: number) => void }) {
  return (
    <div class="source-stack">
      <div class="source-stack-title">Call stack</div>
      {stack.map((frame, i) => (
        <div
          key={i}
          class={`source-stack-frame${i === selected ? ' selected' : ''}`}
          title={`${frame.file}:${frame.line}`}
          onClick={() => onSelect(i)}
        >
          <span class="source-stack-file">{frame.file.split('/').pop()}</span>
          <span class="source-stack-line">:{frame.line}</span>
        </div>
      ))}
    </div>
  );
}

function SourceTab({ event, sources }: { event: ActionTraceEvent | AssertionTraceEvent | undefined; sources: Map<string, string> }) {
  const highlightRef = useRef<HTMLDivElement>(null);
  const [selectedFrame, setSelectedFrame] = useState(0);

  const stack = event?.stack ?? (event?.sourceLocation ? [event.sourceLocation] : []);
  const eventKey = event ? `${event.type}-${event.actionIndex}` : 'none';
  useEffect(() => { setSelectedFrame(0); }, [eventKey]);

  const { filename, content, highlightLine } = resolveSourceView(stack, sources, selectedFrame, !!event);

  useEffect(() => {
    highlightRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [highlightLine, filename]);

  const showStack = stack.length > 1;

  if (content === undefined) {
    return (
      <div class={`source-tab${showStack ? ' has-stack' : ''}`}>
        <div class="source-main">
          <div class="no-content">
            {filename ? `Source not captured for ${filename.split('/').pop()}` : 'No source files in trace'}
          </div>
        </div>
        {showStack && <StackTraceView stack={stack} selected={selectedFrame} onSelect={setSelectedFrame} />}
      </div>
    );
  }

  const lines = content.split('\n');
  let inBlockComment = false;
  const tokenizedLines: SourceToken[][] = [];
  for (const line of lines) {
    const result = tokenizeLine(line, inBlockComment);
    tokenizedLines.push(result.tokens);
    inBlockComment = result.inBlockComment;
  }

  return (
    <div class={`source-tab${showStack ? ' has-stack' : ''}`}>
      <div class="source-main">
        <div class="source-filename">{filename}</div>
        <div class="source-code">
          {tokenizedLines.map((tokens, i) => (
            <div
              key={i}
              ref={highlightLine === i + 1 ? highlightRef : undefined}
              class={`source-line${highlightLine === i + 1 ? ' highlight' : ''}`}
            >
              <span class="source-line-number">{i + 1}</span>
              <span class="source-line-content">
                {tokens.length === 0
                  ? '​'
                  : tokens.map((token, j) => {
                      const color = TOKEN_COLORS[token.type];
                      return color
                        ? <span key={j} style={{ color }}>{token.text}</span>
                        : <span key={j}>{token.text}</span>;
                    })}
              </span>
            </div>
          ))}
        </div>
      </div>
      {showStack && <StackTraceView stack={stack} selected={selectedFrame} onSelect={setSelectedFrame} />}
    </div>
  );
}
```

`useState` and `useEffect` are already imported on line 1.

- [ ] **Step 5: Run, verify the resolver tests pass + typecheck**

Run: `npm run test -- source-view && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Add stack-pane styles** to `ui-mode/styles/ui-mode.css.ts` (near the existing `.source-tab` / `.source-code` rules around line 1634). Use existing theme variables (`--color-*`) consistent with the file:

```ts
  .source-tab.has-stack { display: flex; flex-direction: row; }
  .source-tab.has-stack .source-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .source-stack {
    width: 240px; flex-shrink: 0; overflow-y: auto;
    border-left: 1px solid var(--color-border);
    font-size: 12px;
  }
  .source-stack-title {
    padding: 6px 10px; color: var(--color-text-faint);
    text-transform: uppercase; letter-spacing: 0.04em; font-size: 11px;
  }
  .source-stack-frame {
    display: flex; gap: 2px; padding: 4px 10px; cursor: pointer;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .source-stack-frame:hover { background: var(--color-bg-hover); }
  .source-stack-frame.selected { background: var(--color-bg-active); }
  .source-stack-file { color: var(--color-text); }
  .source-stack-line { color: var(--color-text-faint); }
```

If any `--color-*` variable name above does not exist in `ui-mode.css.ts`, substitute the nearest existing one used by `.source-line.highlight` / hover rows (check the `:root` block at the top of the file).

- [ ] **Step 7: Run the full unit suite + lint + knip**

Run: `npm run test && npm run lint && npm run knip`
Expected: PASS. (`knip` should not flag `resolveSourceView`/`StackTraceView` — `resolveSourceView` is imported by the test; `StackTraceView` is used by `SourceTab`.)

- [ ] **Step 8: Commit**

```bash
git add packages/tapsmith/src/trace-viewer/components/DetailTabs.tsx packages/tapsmith/src/ui-mode/styles/ui-mode.css.ts packages/tapsmith/src/__tests__/source-view.test.ts
git commit -m "Render selected stack frame's source with a call-stack pane"
```

---

## Task 12: Full verification + manual check

**Files:** none (verification only)

- [ ] **Step 1: Run the complete SDK gate**

Run (from `packages/tapsmith/`): `npm run typecheck && npm run lint && npm run test && npm run knip`
Expected: all PASS.

- [ ] **Step 2: Build the SDK and web apps**

Run: `npm run build`
Expected: clean build (the trace viewer + UI mode web apps compile; CI's web typecheck mirrors this).

- [ ] **Step 3: Manual check in UI mode** (requires a device/emulator — start one only for this step)

1. Create a quick fixture: a test that calls an action through a helper file in a *different* file from the test, e.g. `e2e/helpers/nav.ts` exporting `async function goHome(device) { await device.getByText('Home').tap() }`, called from a test.
2. Launch UI mode, run the test.
3. Select the action that ran inside `nav.ts`. Confirm the Source tab shows **`nav.ts`** (not the test file) with the correct line highlighted, and the **Call stack** pane lists both `nav.ts` and the test file; clicking the test-file frame switches the view to the test file at the calling line.
4. Before running a test, confirm the Source tab shows the test file from disk with no highlight.
5. Edit the helper file (without re-running) and confirm the Source tab still shows the version that ran (snapshot, not disk).

- [ ] **Step 4: Manual check in the offline trace viewer**

Open a saved `trace-*.zip` from the run above in the trace viewer; confirm the same per-frame source display works from the embedded `sources.json`.

- [ ] **Step 5: Commit any fixes** discovered during verification (if none, nothing to commit).

---

## Task 13: Documentation

**Files:**
- Review: `docs/api-reference.md`

- [ ] **Step 1: Check for public-API impact**

The `stack` field is internal trace data (not a user-facing API surface like a Device/ElementHandle method). Review `docs/api-reference.md`; if it documents the trace event schema or the Source tab, add a one-line note that the Source tab shows the actual source file per stack frame. Otherwise, **no doc change is required** — record that in the commit/PR description.

- [ ] **Step 2: Commit (only if docs changed)**

```bash
git add docs/api-reference.md
git commit -m "Document per-frame source display in the Source tab"
```

---

## Self-Review Notes (author)

- **Spec coverage:** full stacks (Tasks 1-4), run-time snapshot keyed by abs path (Tasks 5-6, 9), both contexts — offline zip (Tasks 6-7) + live WS (Tasks 8-10), SourceTab + stack pane + resolution priority + pre-run preview + fallback (Task 11), tests throughout, size cap 2 MB (Tasks 6, 9), `file:line` display (Task 11). All spec sections map to tasks.
- **Type consistency:** `extractStack`/`collectReferencedFiles`/`streamSourcesForEvent`/`resolveSourceView` names are used identically across definition, callers, and tests. `SourceMessage` gains `path` consistently across protocol, server, and both child senders.
- **Known soft spots flagged for the implementer:** exact `--color-*` variable names in `ui-mode.css.ts` (verify against `:root`); the `device` shape in the packager test (mirror existing packager tests if the cast complains). Task 3 Step 2 notes the action-event test may pass immediately because `addActionEvent` spreads `...event` — that is expected and the test stands as a regression guard.
