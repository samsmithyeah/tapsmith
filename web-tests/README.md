# UI mode web tests

Playwright suite for the UI mode SPA. **No device, emulator, simulator, or daemon required** — it
runs in a couple of seconds on any machine and in CI.

## Running

```bash
# once, and after any change to the SPA (the suite tests the built bundle)
cd ../packages/tapsmith && npm ci && npm run build

cd ../../web-tests
npm ci
npx playwright install chromium

npm test              # run everything
npm run test:ui       # Playwright's UI runner — best for authoring
npm run typecheck
```

## How it works

UI mode's SPA has exactly two inputs: one WebSocket, and two download-only HTTP routes (`/trace/`,
`/video/`). Everything the user sees — the test tree, statuses, trace actions, screenshots, hierarchy
XML, network entries, device-mirror frames — arrives as a `ServerMessage` on that socket. So the whole
app can be driven from the test process.

- `serve-ui.mjs` serves the built `packages/tapsmith/dist/ui-mode/index.html`. The Vite build inlines
  every asset into one file, so there is exactly one thing to serve. It has to be HTTP rather than
  `file://`, because `use-websocket.ts` derives its socket URL from `location.host`.
- `fake-ui-server.ts` intercepts the socket with Playwright's `page.routeWebSocket()`. It never calls
  `connectToServer()`, so nothing reaches a real socket: **the route is the server**. It can push any
  `ServerMessage`, push binary screen frames, record every `ClientMessage` the SPA sends, and drop the
  connection to exercise the 1s reconnect.
- `protocol.ts` is the only file that reaches into `packages/tapsmith/dist`. Types and
  `encodeScreenFrame` come from the real `ui-protocol.ts`, so fixtures can't drift from the SPA under
  test — and mis-shaped fixtures fail `npm run typecheck` rather than at runtime.

Because the suite runs against `dist/`, **rebuild after changing the SPA**:
`cd ../packages/tapsmith && npm run build:ui-mode`.

## Layout

| Path | What |
|---|---|
| `specs/` | The tests |
| `panes/` | Pane objects — one class per UI surface |
| `messages/` | Builders for protocol payloads (trees, trace events, PNG frames) |
| `fixtures.ts` | Composes the harness and pane objects via `test.extend` |
| `fake-ui-server.ts` | The `routeWebSocket` harness |
| `protocol.ts` | Re-exports the real wire protocol |
| `serve-ui.mjs` | Static server for the built SPA |

## Pane objects

The mobile suite in `e2e/` uses the screen-object pattern documented in `docs/writing-tests.md`; this
suite applies the same conventions to UI mode's panes:

- **One class per pane**, wrapping `page`.
- **Getters, not constructor assignments** — each access yields a fresh lazy locator.
- **Multi-step flows as methods**, so specs read as intent: `explorer.runNode("smoke")`.
- **No assertions in pane objects.** They expose locators and actions; specs decide what to assert.

## Locators

Accessible locators first — `getByRole`, `getByLabel`, `getByTitle`. The classes in
`styles/ui-mode.css.ts` are styling hooks and only incidentally stable, so nothing here selects on
them. Where a surface had no accessible name, the fix was to give it the ARIA it should already have
had rather than to bolt on a testid:

| Surface | Now |
|---|---|
| Test tree | `tree` of `treeitem`s with `aria-level`/`-expanded`/`-selected`, each row explicitly named |
| Status filters (All/Pass/Fail/Skip) | `tablist` of `tab`s |
| Detail tabs, worker tabs | `tablist`/`tab` instead of clickable `div`s |
| Action list | `listbox` of `option`s; in-flight rows carry `aria-busy` |
| Filter box | `aria-label` (a placeholder is not a label) |
| Elapsed time | `role="timer"` |
| Connection strip, mirror placeholder | `role="status"` live regions |
| Notification banners | `role="alert"` (errors) / `role="status"` (notices) |
| Mirror canvas | labelled, per worker in the grid |
| Theme select, per-row run/watch buttons | labelled, so they're distinguishable |

### Locate structurally, assert the value

Nothing is located by its text content. A text locator conflates finding with asserting, so a wrong
value reports "element not found" rather than showing what it actually said. Value readouts are
located by role or test id and then asserted:

```ts
await expect(runControls.connection).toHaveText("Disconnected")     // role="status"
await expect(runControls.passedCount).toHaveText("1 passed")        // data-testid
await expect(explorer.statusFilterCount("Fail")).toHaveText("1")    // data-testid
```

`getByTestId` is the deliberate fallback where there is genuinely no semantics to appeal to — bare
numbers and message strings: `node-duration`, `filter-count`, `count-passed`/`-failed`/`-skipped`,
`tests-empty`, `run-notification`, `preflight-message`, `mirror-status`/`-hint`.

Two exceptions worth knowing: a row's `data-type` and `data-status` are still used for type and
status, because ARIA has no role or state meaning "this test failed" and those are pre-existing
product attributes rather than styling hooks. Both are applied via `.and()` on top of the role, so the
accessible locator stays primary.

Pane objects are trimmed to what the specs exercise. Locators for surfaces without tests yet (pick
mode, worker views, mirror gestures) go in alongside the specs that prove them — an unverified locator
is a liability, not a head start.

## Writing a spec

```ts
import { test, expect } from "../fixtures.js"
import { GESTURES_FILE } from "../messages/scenarios.js"

test("marks a test failed", async ({ app, explorer }) => {
  await explorer.expandAll()

  app.send({
    type: "test-status",
    fullName: "Gestures screen > smoke",
    filePath: GESTURES_FILE,
    status: "failed",
    error: "boom",
  })

  await expect(explorer.node("smoke")).toHaveAttribute("data-status", "failed")
})
```

The `app` fixture is the common case: SPA loaded, one-file tree, idle. Take `ui` instead when a spec
needs to seed a different starting state, then call `ui.open()` — `routeWebSocket` has to be
registered before the SPA opens its socket, and the seed is replayed on every connect, exactly as the
real server re-pushes state on reconnect.

## Regression coverage

Several specs pin bugs that shipped and were found by hand. They are worth keeping honest: revert the
fix, rebuild, and confirm the spec goes red.

| Spec | Bug |
|---|---|
| `run-lifecycle.spec.ts` → `#103` | `Cmd+Shift+R` matched the bare `r` shortcut and fired a run on the way out (fixed in `e9ce4ef`) |
| `run-lifecycle.spec.ts` → `#186` | An `afterAll` attribution re-tag reset a finished test to running, so `run-end` erased its failure and trace (fixed in `e9639ce`) |
| `run-lifecycle.spec.ts` → `#147` | An MCP-initiated run showed no pending state (fixed in `06eace0`) |
| `run-lifecycle.spec.ts` → in-flight actions | The Actions panel looked empty while an action was in flight (`abcf347`) |
