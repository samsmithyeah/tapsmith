// Fixture composition for the UI mode web tests.
//
// Mirrors `e2e/fixtures.ts`: extend the base test with one fixture per pane
// object, and re-export `expect` so specs have a single import.
//
// The `ui` fixture installs the WebSocket interception but deliberately does NOT
// navigate — `page.routeWebSocket()` must be registered before the SPA opens its
// socket, and specs need to seed the tree first. Open with `ui.open()`, or take
// the `app` fixture for the common already-loaded-and-idle case.

import { test as base, expect } from "@playwright/test"
import { FakeUiServer } from "./fake-ui-server.js"
import { TestExplorerPane } from "./panes/test-explorer.pane.js"
import { RunControlsPane } from "./panes/run-controls.pane.js"
import { ActionsPane } from "../panes/actions.pane.js"
import { DevicePane } from "./panes/device.pane.js"
import { McpPane } from "./panes/mcp.pane.js"
import { idleSeed, singleFileTree } from "./messages/scenarios.js"
import type { ServerMessage } from "../protocol.js"

export interface UiHarness extends FakeUiServer {
  /** Navigate to the SPA. Seed first — the server pushes on connect. */
  open(): Promise<void>
}

type Fixtures = {
  ui: UiHarness
  explorer: TestExplorerPane
  runControls: RunControlsPane
  actions: ActionsPane
  device: DevicePane
  mcp: McpPane
  /** The SPA loaded and idle with a one-file tree — the common starting point. */
  app: UiHarness
}

export const test = base.extend<Fixtures>({
  ui: async ({ page }, use) => {
    const server = new FakeUiServer(page)
    await server.install()
    const harness = server as UiHarness
    harness.open = async () => {
      await page.goto("/")
    }
    await use(harness)
  },

  explorer: async ({ page }, use) => {
    await use(new TestExplorerPane(page))
  },

  runControls: async ({ page }, use) => {
    await use(new RunControlsPane(page))
  },

  actions: async ({ page }, use) => {
    await use(new ActionsPane(page))
  },

  device: async ({ page }, use) => {
    await use(new DevicePane(page))
  },

  mcp: async ({ page }, use) => {
    await use(new McpPane(page))
  },

  app: async ({ ui, explorer }, use) => {
    ui.seed(idleSeed(singleFileTree()))
    await ui.open()
    // Gate on the tree having rendered so specs never race the first paint.
    await expect(explorer.nodes.first()).toBeVisible()
    await use(ui)
  },
})

export { expect }
export type { ServerMessage }
