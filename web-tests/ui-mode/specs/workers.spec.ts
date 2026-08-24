// Multi-worker mode: one device per worker, a tab per device, and a grid view
// showing all of them at once. Frames must land on the right canvas.

import { test, expect } from "../fixtures.js"
import { screenFrame } from "../messages/frames.js"
import { idleSeed, singleFileTree } from "../messages/scenarios.js"
import type { ServerMessage } from "../../protocol.js"

const WORKERS: ServerMessage = {
  type: "workers-info",
  workers: [
    { workerId: 0, deviceSerial: "emulator-5554", displayName: "emulator-5554", platform: "android" },
    { workerId: 1, deviceSerial: "emulator-5556", displayName: "emulator-5556", platform: "android" },
  ],
}

function workerStatus(
  workerId: number,
  status: "idle" | "running" | "done" | "initializing" | "error",
  extra: { currentFile?: string; passed?: number; failed?: number } = {},
): ServerMessage {
  return {
    type: "worker-status",
    workerId,
    deviceSerial: workerId === 0 ? "emulator-5554" : "emulator-5556",
    status,
    currentFile: extra.currentFile,
    passed: extra.passed ?? 0,
    failed: extra.failed ?? 0,
    skipped: 0,
  }
}

async function openWithWorkers(ui: {
  seed: (m: ServerMessage[]) => void
  open: () => Promise<void>
}) {
  ui.seed([...idleSeed(singleFileTree()), WORKERS])
  await ui.open()
}

test.describe("Multi-worker mode", () => {
  test("shows a tab per device plus All", async ({ ui, device }) => {
    await openWithWorkers(ui)

    await expect(device.workerTabs).toBeVisible()
    await expect(device.workerTabs.getByRole("tab")).toHaveCount(3)
    await expect(device.workerTab("All")).toBeVisible()
    await expect(device.workerTab("emulator-5554")).toBeVisible()
  })

  test("shows no worker tabs with a single device", async ({ ui, device }) => {
    // The tab strip is noise when there's nothing to switch between. Contrasted
    // against the multi-device case in the same test, so the absence is not just
    // a locator that matches nothing.
    ui.seed(idleSeed(singleFileTree()))
    await ui.open()
    await expect(device.root).toBeVisible()
    await expect(device.workerTabs).toHaveCount(0)

    ui.send(WORKERS)
    await expect(device.workerTabs).toBeVisible()
  })

  test("selecting a device tab tells the server", async ({ ui, device }) => {
    await openWithWorkers(ui)

    await device.selectWorkerView("emulator-5556")
    const msg = await ui.waitForMessage("select-worker-view")
    expect(msg.mode).toBe(1)
  })

  test("marks the selected tab", async ({ ui, device }) => {
    await openWithWorkers(ui)

    await device.selectWorkerView("emulator-5556")
    await expect(device.workerTab("emulator-5556")).toHaveAttribute("aria-selected", "true")
    await expect(device.workerTab("All")).toHaveAttribute("aria-selected", "false")
  })

  test("the All view shows one mirror per device", async ({ ui, device }) => {
    await openWithWorkers(ui)
    await device.selectWorkerView("All")

    await expect(device.mirrorFor("emulator-5554")).toBeVisible()
    await expect(device.mirrorFor("emulator-5556")).toBeVisible()
  })

  test("routes each frame to its own device's canvas", async ({ ui, device }) => {
    await openWithWorkers(ui)
    await device.selectWorkerView("All")

    // Different sizes per worker, so a mis-routed frame is unmistakable.
    ui.sendFrame({ ...screenFrame(120, 260), workerId: 0 })
    ui.sendFrame({ ...screenFrame(200, 420), workerId: 1 })

    await expect(device.mirrorFor("emulator-5554")).toHaveAttribute("width", "120")
    await expect(device.mirrorFor("emulator-5556")).toHaveAttribute("width", "200")
  })

  test("reports each device's connection state in the top rail", async ({ ui, runControls }) => {
    await openWithWorkers(ui)
    await expect(runControls.connection).toContainText("emulator-5554")
    await expect(runControls.connection).toContainText("emulator-5556")
  })

  test("reflects per-worker status", async ({ ui, device }) => {
    await openWithWorkers(ui)

    ui.send(
      workerStatus(0, "running", { currentFile: "gestures.test.ts" }),
      workerStatus(1, "error"),
    )

    // The tab's tooltip is where a worker's state and serial are surfaced.
    await expect(device.workerTab("emulator-5554")).toHaveAttribute("title", /running/)
    await expect(device.workerTab("emulator-5556")).toHaveAttribute("title", /error/)
  })

  test("pick mode is unavailable in the All view", async ({ ui, device }) => {
    await openWithWorkers(ui)
    await device.selectWorkerView("All")

    // There is no single mirror to pick on, so the control must be disabled
    // rather than silently doing nothing.
    await expect(device.pickToggle).toBeDisabled()

    // Picking needs a painted mirror to pick on, so it stays unavailable until
    // the selected worker has sent a frame. Switching re-arms the placeholder,
    // so wait for that before sending one — otherwise the frame can land first
    // and be undone by the re-arm.
    await device.selectWorkerView("emulator-5554")
    await expect(device.mirrorStatus).toHaveText("Starting mirror…")
    await expect(device.pickToggle).toBeDisabled()

    ui.sendFrame({ ...screenFrame(120, 260), workerId: 0 })
    await expect(device.pickToggle).toBeEnabled()
  })
})
