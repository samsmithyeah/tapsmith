# UI Mode Source Tab — Read From Actual Source Files

**Status:** Design / awaiting approval
**Date:** 2026-05-30
**Component:** `packages/tapsmith` (TypeScript SDK + UI mode + trace viewer)

## Problem

The Source tab in UI mode (and the offline trace viewer) does not show the
source file an action actually came from. Today:

- Only the **test file** is captured — it is read from disk once at test start
  (`ui-run.ts`) and streamed as a single `source` message.
- `SourceTab` always renders `[...sources.entries()][0]` (the first/only entry)
  and merely moves the highlighted line using `event.sourceLocation.line`.

So when an action originates in a **helper, page object, or fixture**, the
Source tab shows the wrong file, and the highlighted line number is applied to
the wrong file. There is no call-stack view.

We want to match Playwright's UI mode / trace viewer: show the **actual file**
each action came from, with a clickable **stack-trace pane**, and have the
content reflect **the code that actually ran** (so editing a test after a failed
run still shows the version that failed).

## What Playwright actually does (verified against `microsoft/playwright@main`)

From `packages/trace-viewer/src/ui/sourceTab.tsx`:

- **Content resolution is a priority chain:**
  1. cached `fallbackLocation.source.content`
  2. `fetch('sha1/src@<sha1>.txt')` — the snapshot **stored in the trace**
     (sources are embedded into `trace.zip` at `tracing.stop()` when
     `sources: true`)
  3. `fetch('file?path=<file>')` — falls back to reading the **live file from
     disk** via a server endpoint
  4. `"<Unable to read \"<file>\">"`
- **Stack pane:** renders `<StackTraceView stack selectedFrame setSelectedFrame>`
  in a sidebar; shown only when `stack.length > 1`.
- **File selection:** `const actionLocation = stack[selectedFrame]; const
  location = actionLocation?.file ? actionLocation : fallbackLocation` — the
  selected stack frame drives which file/line is shown; defaults to the action's
  own (top) frame.
- **States:** `'Loading…'` while fetching, `<Unable to read …>` on failure.

**Conclusion:** the snapshot embedded at run time is the primary source; disk is
a fallback. Editing a test after a recorded run does **not** change what the
Source tab shows for that run (until a re-run produces a new trace; with watch
on, saving triggers that re-run).

## Goals

1. Source tab shows the actual file for the selected action, read from the
   **run-time snapshot** — correct for helpers/page-objects/fixtures, not just
   the test file.
2. A clickable **stack-trace pane** lets the user walk the call stack and view
   each frame's file/line.
3. Content reflects the code that ran: editing afterward does not silently
   desync the highlight.
4. Works in **both** live UI mode and the offline trace viewer (shared
   component).
5. Pre-run / no-action-selected → disk preview of the test file, no highlight.

## Non-goals

- No proto / Rust / on-device agent changes (source capture is pure TypeScript).
- No new live disk file-server endpoint (`file?path=`). We always record sources
  at run time, so every action frame is covered by the snapshot; the existing
  test-file-from-disk preview covers the pre-run case. A disk-fallback endpoint
  can be added later if a real gap appears.
- No content-addressed (sha1) source storage. tapsmith eagerly pushes source
  content into an in-memory map (as it already does for screenshots,
  hierarchies, and the test file); we keep that model.

## Design

### 1. Capture full stacks (SDK — pure TypeScript)

`packages/tapsmith/src/trace/trace-collector.ts`

- Add `extractStack(stack: string): SourceLocation[]` next to the existing
  `extractSourceLocation`. Same filtering (skip `/tapsmith/src/`,
  `/tapsmith/dist/`, `node_modules`, `node:`, `internal/`) but collect **all**
  user-code frames in order, top-first.
- Keep `extractSourceLocation` (now expressible as `extractStack(stack)[0]`).

`packages/tapsmith/src/trace/types.ts`

- Add `stack?: SourceLocation[]` to `ActionTraceEvent` and `AssertionTraceEvent`.
- `sourceLocation` remains `stack[0]` for back-compat (Call tab, Errors tab,
  code frames already use it).

Capture sites (~14, all already doing `new Error().stack`): set both
`sourceLocation` (top frame) and `stack` (full filtered list). Most route
through `traced-action.ts` and the `expect.ts` wrappers, so the real edit count
is small; the remainder set the fields inline.

### 2. Snapshot referenced files at run time (SDK)

`TraceCollector` accumulates the set of **absolute file paths** seen across all
captured stacks and reads each from disk **once**, caching content keyed by
absolute path. This replaces "only the test file."

- **Keyed by absolute path**, not basename — fixes collisions between e.g. two
  different `helpers.ts`.
- **Best-effort:** read failures are skipped silently; the tab shows the
  "not captured" fallback for those frames.
- **Size cap:** skip files larger than a fixed limit (e.g. 2 MB) to keep the
  snapshot small; skipped files use the fallback. (Only user-code frames are
  captured — SDK/node_modules already filtered — so the set is naturally small.)
- **Timing:** read lazily when a stack first references a file during the run
  (so live UI mode streams it as actions arrive) and ensure all referenced files
  are flushed before packaging.

### 3. Transport — both contexts read the snapshot

- **Live UI mode** (`ui-protocol.ts`, `ui-server.ts`, `ui-run.ts`,
  `ui-worker.ts`): extend `SourceMessage` to carry the absolute `path` (keep
  `fileName` basename for display). Emit one `source` message per referenced
  file, once. `sourceBuffer` is keyed by `path`; replayed to new clients as
  today.
- **Offline trace viewer** (`trace-packager.ts`, `trace-viewer/main.tsx`): write
  the snapshot into the zip **keyed by absolute path**. Replace today's
  `sources/<basename>` (test file only) with a path-keyed store —
  `sources.json` mapping `{ [absPath]: content }` is the simplest robust option
  and avoids filesystem path-sanitization for the `sources/` dir. The viewer's
  `parseTraceZip` reads `sources.json` into the path-keyed map. (Trace format is
  pre-1.0 and archives are ephemeral, so no migration/back-compat needed.)
- The frontend `sources` map (`use-trace-data.ts`, `main.tsx` for both apps)
  becomes `Map<absPath, content>`.

### 4. SourceTab rewrite (shared component)

`packages/tapsmith/src/trace-viewer/components/DetailTabs.tsx`

- New props: the event already carries `stack`; `sources` is now path-keyed.
- **Layout:** code on the left, **stack-trace pane** on the right. Each frame
  rendered as `<fn?> file:line` (basename for display, full path on hover/title).
- **Selection:** local `selectedFrame` state, default `0` (top frame), reset
  when the selected event changes. Clicking a frame updates it.
- **Show stack pane only when `stack.length > 1`** (matches Playwright).
- **Resolution priority (mirrors Playwright, adapted to eager-push):**
  1. `sources.get(stack[selectedFrame].file)` → render with that frame's line
     highlighted.
  2. no event / no stack (pre-run) → disk-preview test file from `sources`
     (the existing test-start push), no highlight.
  3. file not in snapshot → "source not captured" message; stack pane still
     shown so the user sees where the action came from.
- Reuse the existing tokenizer/highlighter (`tokenizeLine`, `TOKEN_COLORS`) and
  the scroll-into-view behavior, now driven by the selected frame's line.
- Styling: add stack-pane styles in `ui-mode.css.ts` consistent with the
  existing Tapsmith dark theme.

### 5. Edge cases

- Single-frame action → no stack pane, just the file + highlight.
- Frame in a file that failed to read / exceeded the size cap → fallback text,
  pane still navigable.
- Duplicate basenames across directories → resolved by absolute-path keying.
- Watch-triggered re-run → produces a fresh snapshot, so the view stays
  consistent with the latest run.
- Errors tab / Call tab continue to use `sourceLocation` (top frame) unchanged.

## Testing

- **Unit (`trace-collector.test.ts`):** `extractStack` returns ordered
  user-code frames and filters SDK/node_modules/internal frames; multi-frame and
  single-frame stacks; `extractSourceLocation === extractStack()[0]`.
- **Unit (collector):** referenced-file accumulation, single read per file,
  size-cap skip, read-failure skip, content keyed by absolute path.
- **Component (`DetailTabs`/SourceTab):** frame selection drives file + line;
  stack pane hidden for single-frame; pre-run disk preview with no highlight;
  "not captured" fallback.
- **Round-trip:** packager writes `sources.json`; `parseTraceZip` reads it back
  into the path-keyed map.
- **Optional e2e:** a test whose action originates in a helper file — assert the
  Source tab shows the helper file (not the test file) for that action.

## Affected files (anticipated)

- `packages/tapsmith/src/trace/trace-collector.ts` — `extractStack`, snapshot accumulation
- `packages/tapsmith/src/trace/types.ts` — `stack` field
- `packages/tapsmith/src/element-handle.ts`, `device.ts`, `expect.ts`,
  `network.ts`, `api-request.ts`, `webview-handle.ts`, `trace/traced-action.ts`
  — set `stack` at capture sites
- `packages/tapsmith/src/trace/trace-packager.ts` — write `sources.json`
- `packages/tapsmith/src/ui-mode/ui-protocol.ts`, `ui-server.ts`, `ui-run.ts`,
  `ui-worker.ts` — `path` on `SourceMessage`, send all referenced files
- `packages/tapsmith/src/ui-mode/main.tsx`,
  `packages/tapsmith/src/trace-viewer/main.tsx`,
  `packages/tapsmith/src/ui-mode/hooks/use-trace-data.ts` — path-keyed sources map
- `packages/tapsmith/src/trace-viewer/components/DetailTabs.tsx` — SourceTab + stack pane
- `packages/tapsmith/src/ui-mode/styles/ui-mode.css.ts` — stack pane styles
- `docs/api-reference.md` — only if a public type changes (the `stack` field is
  internal trace data; likely no user-facing API change)

## Open questions

- Exact size cap value (proposed 2 MB).
- Whether to render frame function names (requires parsing them out of the stack
  line) or just `file:line`. Playwright shows function names; we can start with
  `file:line` and add names if the stack regex captures them cleanly.
