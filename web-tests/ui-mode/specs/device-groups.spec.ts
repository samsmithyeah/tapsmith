// Device groups (`use.devices`): one worker drives several devices, so the
// pane shows one tab per device — labelled by member name — the All view has
// a tile per device, and pick mode / gestures name the device they target.

import { test, expect } from "../fixtures.js"
import { screenFrame } from "../messages/frames.js"
import { idleSeed, singleFileTree } from "../messages/scenarios.js"
import type { ServerMessage } from "../../protocol.js"

const GROUP_WORKER: ServerMessage = {
  type: "workers-info",
  workers: [
    {
      workerId: 0,
      deviceSerial: "emulator-5554",
      displayName: "emulator-5554",
      platform: "android",
      devicePixelRatio: 2,
      devices: [
        { index: 0, name: "alice", deviceSerial: "emulator-5554", displayName: "emulator-5554", platform: "android", devicePixelRatio: 2 },
        { index: 1, name: "bob", deviceSerial: "emulator-5556", displayName: "emulator-5556", platform: "android", devicePixelRatio: 3 },
      ],
    },
  ],
}

const ALICE = "emulator-5554 · alice"
const BOB = "emulator-5554 · bob"

async function openWithGroup(ui: {
  seed: (m: ServerMessage[]) => void
  open: () => Promise<void>
}) {
  ui.seed([...idleSeed(singleFileTree()), GROUP_WORKER])
  await ui.open()
}

test.describe("Device groups", () => {
  test("shows a tab per group member, named by the member", async ({ ui, device }) => {
    await openWithGroup(ui)

    await expect(device.workerTabs).toBeVisible()
    await expect(device.workerTabs.getByRole("tab")).toHaveCount(3)
    await expect(device.workerTab("All")).toBeVisible()
    await expect(device.workerTab(ALICE)).toBeVisible()
    await expect(device.workerTab(BOB)).toBeVisible()
    // The serial is still reachable from the tooltip.
    await expect(device.workerTab(BOB)).toHaveAttribute("title", /emulator-5556/)
  })

  test("selecting a member tells the server which device to mirror", async ({ ui, device }) => {
    await openWithGroup(ui)

    await device.selectWorkerView(BOB)
    const msg = await ui.waitForMessage("select-worker-view")
    expect(msg.mode).toBe(0)
    expect(msg.deviceIndex).toBe(1)
    await expect(device.workerTab(BOB)).toHaveAttribute("aria-selected", "true")
    await expect(device.workerTab(ALICE)).toHaveAttribute("aria-selected", "false")
  })

  test("the All view shows one mirror per member and routes frames by device", async ({ ui, device }) => {
    await openWithGroup(ui)
    await device.selectWorkerView("All")

    await expect(device.mirrorFor(ALICE)).toBeVisible()
    await expect(device.mirrorFor(BOB)).toBeVisible()

    // Same worker, different device index — different sizes so a frame that
    // ignored the index would be unmistakable.
    ui.sendFrame({ ...screenFrame(120, 260), workerId: 0, deviceIndex: 0 })
    ui.sendFrame({ ...screenFrame(200, 420), workerId: 0, deviceIndex: 1 })

    await expect(device.mirrorFor(ALICE)).toHaveAttribute("width", "120")
    await expect(device.mirrorFor(BOB)).toHaveAttribute("width", "200")
  })

  test("gestures and picks on a member's tab name that device", async ({ ui, device }) => {
    await openWithGroup(ui)
    await device.selectWorkerView(BOB)
    await expect(device.mirrorStatus).toHaveText("Starting mirror…")
    ui.sendFrame({ ...screenFrame(200, 420), workerId: 0, deviceIndex: 1 })
    await expect(device.canvas).toHaveAttribute("width", "200")

    await device.tapMirrorAt(0.5, 0.5)
    const tap = await ui.waitForMessage("mirror-tap")
    expect(tap.workerId).toBe(0)
    expect(tap.deviceIndex).toBe(1)

    await device.enablePickMode()
    const hierarchy = await ui.waitForMessage("request-hierarchy")
    expect(hierarchy.workerId).toBe(0)
    expect(hierarchy.deviceIndex).toBe(1)
  })

  test("a single-device worker keeps its plain label", async ({ ui, device }) => {
    // Contrast: without `devices`, or with one member, no member suffix.
    ui.seed([
      ...idleSeed(singleFileTree()),
      {
        type: "workers-info",
        workers: [
          { workerId: 0, deviceSerial: "emulator-5554", displayName: "emulator-5554", platform: "android" },
          { workerId: 1, deviceSerial: "emulator-5556", displayName: "emulator-5556", platform: "android" },
        ],
      },
    ])
    await ui.open()
    await expect(device.workerTab("emulator-5554")).toBeVisible()
    await expect(device.workerTabs.getByRole("tab", { name: /·/ })).toHaveCount(0)
  })
})

test.describe("Device group badge", () => {
  test("a project that declares use.devices shows a device count on its row", async ({ ui, explorer }) => {
    const tree = singleFileTree()
    tree[0].use = { devices: 2 }
    ui.seed(idleSeed(tree))
    await ui.open()

    await expect(explorer.isolationFor("gestures.test.ts")).toHaveText("2 devices")
    await expect(explorer.isolationFor("gestures.test.ts")).toHaveAttribute("title", /use\.devices/)
  })
})
