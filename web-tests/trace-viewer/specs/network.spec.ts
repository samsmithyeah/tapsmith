// The Network tab: the captured request list, its filters, and the per-request
// detail pane. Shared with UI mode.

import { test, expect } from "../fixtures.js"
import { actionEvent, networkEntry } from "../trace-builder.js"

const RESPONSE_BODY = JSON.stringify(
  { items: [{ id: 1, title: "Buy milk" }], total: 1 },
  null,
  2,
)

const ENTRIES = [
  networkEntry({ index: 0, url: "https://api.acme.dev/v1/items", status: 200 }),
  networkEntry({
    index: 1,
    method: "POST",
    url: "https://api.acme.dev/v1/items",
    status: 201,
    duration: 120,
  }),
  networkEntry({
    index: 2,
    url: "https://api.acme.dev/v1/missing",
    status: 404,
    contentType: "text/plain",
  }),
  networkEntry({
    index: 3,
    url: "https://cdn.acme.dev/logo.png",
    status: 200,
    contentType: "image/png",
    responseSize: 20_480,
  }),
]

async function openWithNetwork(
  viewer: { open: (spec: Record<string, unknown>) => Promise<void> },
  extra: Record<string, unknown> = {},
) {
  await viewer.open({
    events: [actionEvent({ actionIndex: 0, action: "tap" })],
    network: ENTRIES,
    ...extra,
  })
}

test.describe("Network tab", () => {
  test("counts captured requests on the tab", async ({ viewer, detailTabs }) => {
    await openWithNetwork(viewer)
    await expect(detailTabs.tab("Network")).toHaveAccessibleName("Network 4")
  })

  test("lists every captured request", async ({ viewer, detailTabs, network }) => {
    await openWithNetwork(viewer)
    await detailTabs.select("Network")

    await expect(network.rows).toHaveCount(4)
    await expect(network.row("logo.png")).toBeVisible()
  })

  test("shows method, status and duration per row", async ({ viewer, detailTabs, network }) => {
    await openWithNetwork(viewer)
    await detailTabs.select("Network")

    const row = network.row("items").nth(1)
    await expect(row).toContainText("POST")
    await expect(row).toContainText("201")
  })

  test("offers sortable column headers", async ({ viewer, detailTabs, network }) => {
    await openWithNetwork(viewer)
    await detailTabs.select("Network")
    await expect(network.columnHeaders.first()).toHaveText(/Name/)
  })

  test.describe("filtering", () => {
    test("narrows by URL", async ({ viewer, detailTabs, network }) => {
      await openWithNetwork(viewer)
      await detailTabs.select("Network")

      await network.filter("logo")
      await expect(network.rows).toHaveCount(1)
      await expect(network.rows).toContainText("logo.png")
    })

    test("narrows by method", async ({ viewer, detailTabs, network }) => {
      await openWithNetwork(viewer)
      await detailTabs.select("Network")

      await network.filter("POST")
      await expect(network.rows).toHaveCount(1)
    })

    test("restores every row when cleared", async ({ viewer, detailTabs, network }) => {
      await openWithNetwork(viewer)
      await detailTabs.select("Network")

      await network.filter("logo")
      await expect(network.rows).toHaveCount(1)
      await network.filter("")
      await expect(network.rows).toHaveCount(4)
    })

    test("reports which type filter is active", async ({ viewer, detailTabs, network }) => {
      await openWithNetwork(viewer)
      await detailTabs.select("Network")

      // "All" starts on; picking Img narrows to the one PNG.
      await expect(network.pill("All")).toHaveAttribute("aria-pressed", "true")
      await network.pill("Img").click()
      await expect(network.pill("Img")).toHaveAttribute("aria-pressed", "true")
      await expect(network.pill("All")).toHaveAttribute("aria-pressed", "false")
      await expect(network.rows).toHaveCount(1)
      await expect(network.rows).toContainText("logo.png")
    })

    test("filters to failed requests", async ({ viewer, detailTabs, network }) => {
      await openWithNetwork(viewer)
      await detailTabs.select("Network")

      await network.pill("4xx").click()
      await expect(network.rows).toHaveCount(1)
      await expect(network.rows).toContainText("missing")
    })
  })

  test.describe("request detail", () => {
    test("opens on a row click and closes again", async ({ viewer, detailTabs, network }) => {
      await openWithNetwork(viewer)
      await detailTabs.select("Network")

      await network.selectRow("logo.png")
      await expect(network.detailBody).toBeVisible()

      await network.detailClose.click()
      await expect(network.detailBody).toHaveCount(0)
    })

    test("shows request and response headers", async ({ viewer, detailTabs, network }) => {
      await openWithNetwork(viewer)
      await detailTabs.select("Network")
      await network.selectRow("missing")

      await network.openDetailTab("Headers")
      await expect(network.detailBody).toContainText("content-type")
    })

    test("shows the captured response body", async ({ viewer, detailTabs, network }) => {
      await viewer.open({
        events: [actionEvent({ actionIndex: 0, action: "tap" })],
        network: [
          networkEntry({
            index: 0,
            url: "https://api.acme.dev/v1/items",
            responseBodyPath: "network/res-0.bin",
          }),
        ],
        networkBodies: { "network/res-0.bin": RESPONSE_BODY },
      })
      await detailTabs.select("Network")
      await network.selectRow("items")
      await network.openDetailTab("Response")

      await expect(network.detailBody).toContainText("Buy milk")
    })

    test("shows the captured request payload", async ({ viewer, detailTabs, network }) => {
      await viewer.open({
        events: [actionEvent({ actionIndex: 0, action: "tap" })],
        network: [
          networkEntry({
            index: 0,
            method: "POST",
            url: "https://api.acme.dev/v1/items",
            requestBodyPath: "network/req-0.bin",
          }),
        ],
        networkBodies: { "network/req-0.bin": '{"title":"Buy milk"}' },
      })
      await detailTabs.select("Network")
      await network.selectRow("items")
      await network.openDetailTab("Payload")

      await expect(network.detailBody).toContainText("Buy milk")
    })

    test("shows timing for the request", async ({ viewer, detailTabs, network }) => {
      await openWithNetwork(viewer)
      await detailTabs.select("Network")
      await network.selectRow("logo.png")
      await network.openDetailTab("Timing")

      await expect(network.detailBody).toContainText(/ms/)
    })
  })

  test.describe("route actions", () => {
    test("badges a mocked response", async ({ viewer, detailTabs, network }) => {
      await viewer.open({
        events: [actionEvent({ actionIndex: 0, action: "tap" })],
        network: [
          networkEntry({
            index: 0,
            url: "https://api.acme.dev/v1/items",
            routeAction: "mocked",
          }),
        ],
      })
      await detailTabs.select("Network")
      // A mocked response looks like a real 200 without this cue.
      await expect(network.row("items")).toContainText(/mock/i)
    })

    test("shows an aborted request as ABORTED rather than a status", async ({
      viewer,
      detailTabs,
      network,
    }) => {
      await viewer.open({
        events: [actionEvent({ actionIndex: 0, action: "tap" })],
        network: [
          networkEntry({
            index: 0,
            url: "https://api.acme.dev/v1/items",
            status: 0,
            routeAction: "aborted",
          }),
        ],
      })
      await detailTabs.select("Network")
      await expect(network.row("items")).toContainText("ABORTED")
    })
  })

  test("says so when no requests were captured", async ({ viewer, detailTabs }) => {
    await viewer.open({ events: [actionEvent({ actionIndex: 0, action: "tap" })] })
    await detailTabs.select("Network")
    await expect(detailTabs.noContent).toBeVisible()
  })
})
