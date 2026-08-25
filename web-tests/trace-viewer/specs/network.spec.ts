// The Network tab: the captured request list, its filters, and the per-request
// detail pane. Shared with UI mode.

import { test, expect } from "../fixtures.js"
import { actionEvent, networkEntry, type TraceSpec } from "../trace-builder.js"
import type { ViewerHarness } from "../fixtures.js"

const RESPONSE_BODY = JSON.stringify(
  { items: [{ id: 1, title: "Buy milk" }], total: 1 },
  null,
  2,
)

// ─── gRPC body builders ───
// Built here rather than captured: real Firestore bodies carry account data,
// and a hand-built message states exactly which wire-format shape is under test.

function varint(value: number): number[] {
  const out: number[] = []
  let v = value
  do {
    const byte = v & 0x7f
    v >>>= 7
    out.push(v > 0 ? byte | 0x80 : byte)
  } while (v > 0)
  return out
}

/** A length-delimited (wire type 2) string field. */
function protoString(fieldNumber: number, text: string): number[] {
  const payload = Array.from(new TextEncoder().encode(text))
  return [(fieldNumber << 3) | 2, ...varint(payload.length), ...payload]
}

/** A length-delimited field wrapping a nested message. */
function protoNested(fieldNumber: number, inner: number[]): number[] {
  return [(fieldNumber << 3) | 2, ...varint(inner.length), ...inner]
}

/** Wrap a message in gRPC framing: `[flag][4-byte big-endian length][message]`. */
function grpcFrame(message: number[]): number[] {
  const len = message.length
  return [0, (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff, ...message]
}

/** A Firestore-shaped ListenRequest: database path plus a nested target. */
const LISTEN_REQUEST = new Uint8Array(
  grpcFrame([
    ...protoString(1, "projects/demo/databases/(default)"),
    ...protoNested(2, protoString(2, "projects/demo/databases/(default)/documents/users/u1")),
  ]),
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

async function openWithNetwork(viewer: ViewerHarness, extra: TraceSpec = {}) {
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
    // The fixture sets 120ms on this entry; asserting it is the difference
    // between checking the column exists and checking it carries the value.
    await expect(row).toContainText("120 ms")
  })

  test("sorts when a column header is clicked", async ({ viewer, detailTabs, network }) => {
    await openWithNetwork(viewer)
    await detailTabs.select("Network")
    await expect(network.columnHeaders.first()).toHaveText(/Name/)

    // Capture order, sort by status, and check it actually changed — the header
    // rendering alone says nothing about whether clicking it does anything.
    const before = await network.rows.evaluateAll((rows) =>
      rows.map((r) => r.textContent ?? ""),
    )
    await network.columnHeaders.filter({ hasText: "Status" }).click()
    const after = await network.rows.evaluateAll((rows) =>
      rows.map((r) => r.textContent ?? ""),
    )

    expect(after).not.toEqual(before)
    expect([...after].sort()).toEqual([...before].sort())
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

      // The fixture's own duration, not a bare /ms/ — which nearly any content
      // in this pane would satisfy.
      await expect(network.detailBody).toContainText("35 ms")
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

  // ─── gRPC / protobuf bodies (PILOT-279 follow-on) ───
  // These bodies are binary, so they exercise the one path a string-valued body
  // map could not: the viewer keeps raw bytes and decodes at render time.
  test.describe("gRPC and protobuf bodies", () => {
    const grpcEntry = () =>
      networkEntry({
        index: 0,
        method: "POST",
        url: "https://firestore.googleapis.com/google.firestore.v1.Firestore/Listen",
        status: 200,
        contentType: "application/grpc",
        requestBodyPath: "network/req-0.bin",
      })

    test("decodes a gRPC body into readable protobuf fields", async ({
      viewer,
      detailTabs,
      network,
    }) => {
      await viewer.open({
        events: [actionEvent({ actionIndex: 0, action: "tap" })],
        network: [grpcEntry()],
        networkBodies: { "network/req-0.bin": LISTEN_REQUEST },
      })
      await detailTabs.select("Network")
      await network.selectRow("Listen")
      await network.openDetailTab("Payload")

      // The decoder's verdict, not just the content type.
      await expect(network.bodyInfo).toContainText("gRPC")
      // Strings inside the protobuf are readable, and nesting is shown.
      await expect(network.detailBody).toContainText(
        "projects/demo/databases/(default)/documents/users/u1",
      )
      await expect(network.detailBody).toContainText("2 {")
    })

    test("can switch between the decoded view and the raw bytes", async ({
      viewer,
      detailTabs,
      network,
    }) => {
      await viewer.open({
        events: [actionEvent({ actionIndex: 0, action: "tap" })],
        network: [grpcEntry()],
        networkBodies: { "network/req-0.bin": LISTEN_REQUEST },
      })
      await detailTabs.select("Network")
      await network.selectRow("Listen")
      await network.openDetailTab("Payload")

      await expect(network.decodeToggle).toBeVisible()
      await network.decodeToggle.click()

      // Raw view drops the decoded field markers but keeps the readable text
      // that happens to be embedded in the bytes.
      await expect(network.bodyInfo).toContainText("grpc")
      await expect(network.detailBody).not.toContainText("2 {")
    })

    test("does not offer a decoded view for a JSON body", async ({
      viewer,
      detailTabs,
      network,
    }) => {
      // Guards the heuristic: JSON must keep its Pretty/Raw behaviour and never
      // be reported as protobuf.
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

      await expect(network.bodyInfo).toContainText("json")
      await expect(network.detailBody).toContainText("Buy milk")
    })
  })
})
