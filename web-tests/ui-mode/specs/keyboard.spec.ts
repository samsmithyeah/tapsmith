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
  // A toggle group, not a tab strip — so each filter is its own tab stop and
  // Enter/Space activate it. There is no arrow-key navigation to test.
  test("each filter is a tab stop, in order", async ({ app, explorer, page }) => {
    void app
    await explorer.statusFilter("All").focus()

    // Pressing Tab rather than calling focus(), so this actually exercises
    // sequential navigation instead of asserting focus can be forced.
    for (const label of ["Pass", "Fail", "Skip"] as const) {
      await page.keyboard.press("Tab")
      await expect(explorer.statusFilter(label)).toBeFocused()
    }
  })

  test("Enter and Space apply the focused filter", async ({ app, explorer, page }) => {
    const ui = app
    ui.send({
      type: "test-status",
      fullName: "Gestures screen > double tap registers double tap gesture",
      filePath: GESTURES_FILE,
      status: "failed",
      error: "boom",
    })
    await expect(explorer.statusFilterCount("Fail")).toHaveText("1")

    await explorer.statusFilter("Fail").focus()
    await page.keyboard.press("Enter")
    await expect(explorer.statusFilter("Fail")).toHaveAttribute("aria-pressed", "true")
    await expect(explorer.node("double tap registers double tap gesture")).toBeVisible()

    await explorer.statusFilter("All").focus()
    await page.keyboard.press(" ")
    await expect(explorer.statusFilter("All")).toHaveAttribute("aria-pressed", "true")
    await expect(explorer.statusFilter("Fail")).toHaveAttribute("aria-pressed", "false")
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
