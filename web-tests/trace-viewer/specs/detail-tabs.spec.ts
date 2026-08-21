// The detail pane's tabs. These components are shared with UI mode
// (`main.tsx` imports DetailTabs), so this covers both apps' rendering of them.

import { test, expect } from "../fixtures.js"
import { actionEvent, assertionEvent, consoleEvent } from "../trace-builder.js"

const SOURCE_PATH = "/repo/e2e/tests/gestures.test.ts"
const SOURCE = `import { describe, expect, test } from "../fixtures.js"

describe("Gestures screen", () => {
  test("double tap registers double tap gesture", async ({ gesturesScreen }) => {
    await gesturesScreen.tapArea.doubleTap()
    await expect(gesturesScreen.lastGesture).toContainText("Double tap")
  })
})
`

test.describe("Detail tabs", () => {
  test("opens on Call and switches to another tab", async ({ viewer, detailTabs, actions }) => {
    await viewer.open({ events: [actionEvent({ actionIndex: 0, action: "doubleTap" })] })
    await actions.items.first().click()

    await expect(detailTabs.tab("Call")).toHaveAttribute("aria-selected", "true")

    await detailTabs.select("Log")
    await expect(detailTabs.tab("Log")).toHaveAttribute("aria-selected", "true")
    await expect(detailTabs.tab("Call")).toHaveAttribute("aria-selected", "false")
  })

  test("remembers the chosen tab across a reload", async ({ viewer, detailTabs, page }) => {
    await viewer.open({ events: [actionEvent({ actionIndex: 0, action: "tap" })] })
    await detailTabs.select("Console")
    await expect(detailTabs.tab("Console")).toHaveAttribute("aria-selected", "true")

    await page.reload()
    await expect(detailTabs.tab("Console")).toHaveAttribute("aria-selected", "true")
  })

  test.describe("Call", () => {
    test("describes the selected action", async ({ viewer, detailTabs, actions }) => {
      await viewer.open({
        events: [
          actionEvent({
            actionIndex: 0,
            action: "doubleTap",
            selector: 'getByRole("button", { name: "Tap area" })',
            duration: 84,
          }),
        ],
      })
      await actions.items.first().click()

      await expect(detailTabs.callGrid).toContainText("doubleTap")
      await expect(detailTabs.callGrid).toContainText("Tap area")
    })

    test("describes a failed action's error", async ({ viewer, detailTabs, actions }) => {
      await viewer.open({
        events: [
          actionEvent({
            actionIndex: 0,
            action: "tap",
            success: false,
            error: "Element not found: getByText('Nope')",
          }),
        ],
      })
      await actions.items.first().click()

      await expect(detailTabs.callGrid).toContainText("Element not found")
    })

    test("describes an assertion's expected and received values", async ({
      viewer,
      detailTabs,
      actions,
    }) => {
      await viewer.open({
        events: [
          assertionEvent({
            actionIndex: 0,
            assertion: "toContainText",
            selector: 'getByTestId("last-gesture")',
            passed: false,
            expected: "Double tap",
            actual: "Last gesture: None",
            error: "Timed out waiting for text",
          }),
        ],
      })
      await actions.items.first().click()

      await expect(detailTabs.callGrid).toContainText("Double tap")
      await expect(detailTabs.callGrid).toContainText("Last gesture: None")
    })

    test("opens with the first action already selected", async ({ viewer, detailTabs }) => {
      // Nothing-selected is unreachable here: the viewer pins action 0 on load,
      // so the Call tab has content without a click.
      await viewer.open({
        events: [
          actionEvent({ actionIndex: 0, action: "launchApp" }),
          actionEvent({ actionIndex: 1, action: "doubleTap" }),
        ],
      })
      await expect(detailTabs.callGrid).toContainText("launchApp")
    })
  })

  test.describe("Console", () => {
    test("lists captured console output", async ({ viewer, detailTabs }) => {
      await viewer.open({
        events: [
          actionEvent({ actionIndex: 0, action: "tap" }),
          consoleEvent({ actionIndex: 0, level: "log", message: "app started" }),
          consoleEvent({ actionIndex: 0, level: "warn", message: "slow frame" }),
          consoleEvent({ actionIndex: 0, level: "error", message: "network unreachable" }),
        ],
      })
      await detailTabs.select("Console")

      await expect(detailTabs.consoleEntries).toHaveCount(3)
      await expect(detailTabs.consoleOutput).toContainText("network unreachable")
    })

    test("filters by text", async ({ viewer, detailTabs }) => {
      await viewer.open({
        events: [
          actionEvent({ actionIndex: 0, action: "tap" }),
          consoleEvent({ actionIndex: 0, level: "log", message: "app started" }),
          consoleEvent({ actionIndex: 0, level: "error", message: "network unreachable" }),
        ],
      })
      await detailTabs.select("Console")
      await detailTabs.consoleSearch.fill("network")

      await expect(detailTabs.consoleEntries).toHaveCount(1)
      await expect(detailTabs.consoleEntries).toContainText("network unreachable")
    })

    test("marks the tab when there is output to see", async ({ viewer, detailTabs }) => {
      await viewer.open({
        events: [
          actionEvent({ actionIndex: 0, action: "tap" }),
          consoleEvent({ actionIndex: 0, level: "log", message: "hello" }),
        ],
      })
      // A dot on the tab is the only cue that output exists without opening it.
      await expect(detailTabs.tab("Console").locator(".detail-tab-dot")).toBeVisible()
    })

    test("says so when nothing was captured", async ({ viewer, detailTabs }) => {
      await viewer.open({ events: [actionEvent({ actionIndex: 0, action: "tap" })] })
      await detailTabs.select("Console")
      await expect(detailTabs.noContent).toContainText("No console output recorded")
    })
  })

  test.describe("Source", () => {
    test("shows the captured test source", async ({ viewer, detailTabs, actions }) => {
      await viewer.open({
        events: [
          actionEvent({
            actionIndex: 0,
            action: "doubleTap",
            sourceLocation: { file: SOURCE_PATH, line: 5 },
          }),
        ],
        sources: { [SOURCE_PATH]: SOURCE },
      })
      await actions.items.first().click()
      await detailTabs.select("Source")

      // The header carries the full captured path, not just the basename.
      await expect(detailTabs.sourceFilename).toHaveText(SOURCE_PATH)
      await expect(detailTabs.sourceLines.first()).toBeVisible()
      await expect(detailTabs.sourceLines).toHaveCount(SOURCE.split("\n").length)
    })

    test("says so when sources were not captured", async ({ viewer, detailTabs, actions }) => {
      await viewer.open({ events: [actionEvent({ actionIndex: 0, action: "tap" })] })
      await actions.items.first().click()
      await detailTabs.select("Source")
      await expect(detailTabs.noContent).toBeVisible()
    })
  })

  test.describe("Errors", () => {
    test("lists the test's failure", async ({ viewer, detailTabs }) => {
      await viewer.open({
        metadata: {
          testStatus: "failed",
          error: "expected 'Double tap' but got 'Last gesture: None'",
        },
        events: [actionEvent({ actionIndex: 0, action: "tap" })],
      })
      await detailTabs.select("Errors")

      await expect(detailTabs.errorEntries.first()).toContainText("expected 'Double tap'")
    })

    test("flags the tab when the test failed", async ({ viewer, detailTabs }) => {
      await viewer.open({
        metadata: { testStatus: "failed", error: "boom" },
        events: [actionEvent({ actionIndex: 0, action: "tap" })],
      })
      // The Errors tab turns red so a failure is visible without hunting.
      await expect(detailTabs.tab("Errors")).toHaveClass(/has-error/)
    })

    test("lists a failed action alongside the test error", async ({ viewer, detailTabs }) => {
      await viewer.open({
        metadata: { testStatus: "failed", error: "assertion failed" },
        events: [
          actionEvent({ actionIndex: 0, action: "tap" }),
          actionEvent({
            actionIndex: 1,
            action: "doubleTap",
            success: false,
            error: "Element not found",
          }),
        ],
      })
      await detailTabs.select("Errors")
      await expect(detailTabs.errorEntries).toHaveCount(2)
    })

    test("shows no error entries for a passing test", async ({ viewer, detailTabs }) => {
      await viewer.open({ events: [actionEvent({ actionIndex: 0, action: "tap" })] })
      await detailTabs.select("Errors")
      await expect(detailTabs.errorEntries).toHaveCount(0)
    })
  })
})
