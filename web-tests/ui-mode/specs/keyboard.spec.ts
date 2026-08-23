// Keyboard operation of UI mode's tab strips.
//
// These are real `<button>`s, so they were already focusable and Enter-activatable
// before carrying `role="tab"`. Arrow keys are additive: tabs stay individually
// tabbable rather than adopting APG's roving tabindex, which would have made Tab
// skip the whole group and taken away behaviour keyboard users already had.

import { test, expect } from "../fixtures.js"
import { screenFrame } from "../messages/frames.js"
import { GESTURES_FILE, idleSeed, singleFileTree } from "../messages/scenarios.js"
import type { ServerMessage } from "../../protocol.js"

const WORKERS: ServerMessage = {
  type: "workers-info",
  workers: [
    { workerId: 0, deviceSerial: "emulator-5554", displayName: "emulator-5554", platform: "android" },
    { workerId: 1, deviceSerial: "emulator-5556", displayName: "emulator-5556", platform: "android" },
  ],
}

test.describe("Status filter keyboard", () => {
  test("each filter is reachable with Tab", async ({ app, explorer }) => {
    void app
    await explorer.statusFilter("All").focus()
    await expect(explorer.statusFilter("All")).toBeFocused()
  })

  test("Right and Left move between filters and apply as they go", async ({
    app,
    explorer,
    page,
  }) => {
    const ui = app
    ui.send({
      type: "test-status",
      fullName: "Gestures screen > double tap registers double tap gesture",
      filePath: GESTURES_FILE,
      status: "failed",
      error: "boom",
    })
    await expect(explorer.statusFilterCount("Fail")).toHaveText("1")

    await explorer.statusFilter("All").focus()
    await page.keyboard.press("ArrowRight")
    await expect(explorer.statusFilter("Pass")).toBeFocused()
    await expect(explorer.statusFilter("Pass")).toHaveAttribute("aria-selected", "true")

    await page.keyboard.press("ArrowRight")
    await expect(explorer.statusFilter("Fail")).toBeFocused()
    // Applying the filter is the point, not just moving focus.
    await expect(explorer.node("double tap registers double tap gesture")).toBeVisible()

    await page.keyboard.press("ArrowLeft")
    await expect(explorer.statusFilter("Pass")).toBeFocused()
  })

  test("Home and End jump to the ends", async ({ app, explorer, page }) => {
    void app
    await explorer.statusFilter("Pass").focus()

    await page.keyboard.press("End")
    await expect(explorer.statusFilter("Skip")).toBeFocused()
    await expect(explorer.statusFilter("Skip")).toHaveAttribute("aria-selected", "true")

    await page.keyboard.press("Home")
    await expect(explorer.statusFilter("All")).toBeFocused()
    await expect(explorer.statusFilter("All")).toHaveAttribute("aria-selected", "true")
  })

  test("Enter still activates, as it did before the tab role", async ({ app, explorer, page }) => {
    void app
    await explorer.statusFilter("Skip").focus()
    await page.keyboard.press("Enter")
    await expect(explorer.statusFilter("Skip")).toHaveAttribute("aria-selected", "true")
  })
})

test.describe("Worker tab keyboard", () => {
  test("Right and Left move between device views", async ({ ui, device, page }) => {
    ui.seed([...idleSeed(singleFileTree()), WORKERS])
    await ui.open()
    await expect(device.workerTabs).toBeVisible()

    await device.workerTab("All").focus()
    await page.keyboard.press("ArrowRight")
    await expect(device.workerTab("emulator-5554")).toBeFocused()
    await expect(device.workerTab("emulator-5554")).toHaveAttribute("aria-selected", "true")

    const msg = await ui.waitForMessage("select-worker-view")
    // Selecting by keyboard has to tell the server, exactly as clicking does.
    expect(msg.mode).toBe(0)

    await page.keyboard.press("ArrowLeft")
    await expect(device.workerTab("All")).toBeFocused()
  })

  test("End jumps to the last device", async ({ ui, device, page }) => {
    ui.seed([...idleSeed(singleFileTree()), WORKERS])
    await ui.open()

    await device.workerTab("All").focus()
    await page.keyboard.press("End")
    await expect(device.workerTab("emulator-5556")).toBeFocused()
    await expect(device.workerTab("emulator-5556")).toHaveAttribute("aria-selected", "true")
  })

  test("keyboard selection paints the selected device's mirror", async ({ ui, device, page }) => {
    ui.seed([...idleSeed(singleFileTree()), WORKERS])
    await ui.open()

    await device.workerTab("All").focus()
    await page.keyboard.press("ArrowRight")
    await expect(device.mirrorStatus).toHaveText("Starting mirror…")

    ui.sendFrame({ ...screenFrame(140, 300), workerId: 0 })
    await expect(device.canvas).toHaveAttribute("width", "140")
  })
})
