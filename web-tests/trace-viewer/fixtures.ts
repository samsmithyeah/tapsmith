// Fixture composition for the standalone trace viewer.
//
// The viewer takes a `?trace=<url>` parameter and `fetch`es it, so the archive is
// served by fulfilling that request from the test process — the same idea as
// intercepting UI mode's WebSocket, and it keeps fixture archives out of temp
// files. The real `show-trace-server.ts` serves the identical contract (it also
// has its own vitest coverage); what these specs exercise is the viewer app.

import { test as base, expect } from "@playwright/test"
import { ActionsPane } from "../panes/actions.pane.js"
import { DetailTabsPane } from "../panes/detail-tabs.pane.js"
import { NetworkPane } from "../panes/network.pane.js"
import { HierarchyPane } from "../panes/hierarchy.pane.js"
import { LocatorPane } from "../panes/locator.pane.js"
import { ScreenshotPane } from "../panes/screenshot.pane.js"
import { FilmstripPane } from "../panes/filmstrip.pane.js"
import { buildTrace, type TraceSpec } from "./trace-builder.js"

const TRACE_URL = "/fixture-trace.zip"

export interface ViewerHarness {
  /** Serve this archive and open the viewer on it. */
  open(spec?: TraceSpec): Promise<void>
  /** Open the viewer with no `?trace=`, showing the drop zone. */
  openEmpty(): Promise<void>
  /** Fail the trace fetch, to exercise the viewer's load-error path. */
  openWithFetchFailure(status?: number): Promise<void>
}

type Fixtures = {
  viewer: ViewerHarness
  actions: ActionsPane
  detailTabs: DetailTabsPane
  network: NetworkPane
  hierarchy: HierarchyPane
  locator: LocatorPane
  screenshotPanel: ScreenshotPane
  filmstrip: FilmstripPane
}

export const test = base.extend<Fixtures>({
  viewer: async ({ page }, use) => {
    // Matched on pathname, not a glob: the page URL carries the archive path as
    // a query value, so `**/fixture-trace.zip` would also match the navigation
    // itself and fulfil the document as a zip ("Download is starting").
    const serve = async (body: Uint8Array | null, status = 200) => {
      await page.route((url) => url.pathname === TRACE_URL, (route) =>
        body
          ? route.fulfill({
              status,
              contentType: "application/zip",
              body: Buffer.from(body),
            })
          : route.fulfill({ status, contentType: "text/plain", body: "nope" }),
      )
    }

    await use({
      async open(spec: TraceSpec = {}) {
        await serve(buildTrace(spec))
        await page.goto(`/trace-viewer/?trace=${TRACE_URL}`)
      },
      async openEmpty() {
        await page.goto("/trace-viewer/")
      },
      async openWithFetchFailure(status = 500) {
        await serve(null, status)
        await page.goto(`/trace-viewer/?trace=${TRACE_URL}`)
      },
    })
  },

  actions: async ({ page }, use) => {
    await use(new ActionsPane(page))
  },
  detailTabs: async ({ page }, use) => {
    await use(new DetailTabsPane(page))
  },
  network: async ({ page }, use) => {
    await use(new NetworkPane(page))
  },
  hierarchy: async ({ page }, use) => {
    await use(new HierarchyPane(page))
  },
  locator: async ({ page }, use) => {
    await use(new LocatorPane(page))
  },
  screenshotPanel: async ({ page }, use) => {
    await use(new ScreenshotPane(page))
  },
  filmstrip: async ({ page }, use) => {
    await use(new FilmstripPane(page))
  },
})

export { expect }
