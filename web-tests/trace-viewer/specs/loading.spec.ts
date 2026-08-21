// Loading a trace archive: the viewer's entry point, and how it behaves when the
// archive is missing, malformed or unreachable.

import { test, expect } from "../fixtures.js"
import { actionEvent } from "../trace-builder.js"

test.describe("Loading a trace", () => {
  test("renders the test summary from metadata", async ({ viewer, filmstrip }) => {
    await viewer.open({
      metadata: {
        testName: "Gestures screen > double tap registers double tap gesture",
        testFile: "/repo/e2e/tests/gestures.test.ts",
        testDuration: 1200,
      },
      events: [actionEvent({ actionIndex: 0, action: "tap" })],
    })

    await expect(filmstrip.summary).toContainText("double tap registers double tap gesture")
    await expect(filmstrip.summary).toContainText("gestures.test.ts")
    await expect(filmstrip.summary).toContainText("1200ms")
  })

  test("names the project in the breadcrumb when one is set", async ({ viewer, filmstrip }) => {
    await viewer.open({
      metadata: { project: "ios" },
      events: [actionEvent({ actionIndex: 0, action: "tap" })],
    })
    await expect(filmstrip.summary).toContainText("ios")
  })

  test("reports the device", async ({ viewer, filmstrip }) => {
    await viewer.open({
      metadata: { device: { serial: "emulator-5554", model: "Pixel 8", isEmulator: true } },
      events: [actionEvent({ actionIndex: 0, action: "tap" })],
    })
    await expect(filmstrip.summary).toContainText("Pixel 8")
  })

  test("renders one filmstrip frame per traced event", async ({ viewer, filmstrip }) => {
    await viewer.open({
      events: [
        actionEvent({ actionIndex: 0, action: "tap" }),
        actionEvent({ actionIndex: 1, action: "doubleTap" }),
        actionEvent({ actionIndex: 2, action: "swipe" }),
      ],
    })
    await expect(filmstrip.frames).toHaveCount(3)
  })

  test("shows the drop zone with no trace parameter", async ({ viewer, page }) => {
    await viewer.openEmpty()
    // The viewer's landing state invites a file rather than erroring.
    await expect(page.locator("body")).toContainText(/drop|drag|choose|select/i)
  })

  test("surfaces a failed fetch rather than hanging", async ({ viewer, page }) => {
    await viewer.openWithFetchFailure(500)
    await expect(page.locator("body")).toContainText(/HTTP 500|failed/i)
  })

  test("surfaces an archive with no metadata.json", async ({ viewer, page }) => {
    await viewer.open({ omitMetadata: true })
    await expect(page.locator("body")).toContainText(/metadata/i)
  })

  test("loads an archive with no events at all", async ({ viewer, actions }) => {
    // A test that failed before its first action still produces an archive.
    await viewer.open({ events: [] })
    await expect(actions.items).toHaveCount(0)
  })
})
