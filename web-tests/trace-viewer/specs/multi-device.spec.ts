// A trace recorded by a two-device test (`use.devices`): every event names the
// device that produced it and the metadata lists both devices. The viewer has
// to keep the two apart — which row ran where, whose pixel ratio to scale
// bounds by, and what "after" means when the next action belongs to the other
// user.

import { test, expect } from "../fixtures.js"
import { actionEvent, assertionEvent } from "../trace-builder.js"
import { solidPng } from "../../png.js"
import type { Page } from "@playwright/test"

const SCREEN = { width: 240, height: 500 }
const RED: [number, number, number] = [200, 30, 30]
const GREEN: [number, number, number] = [30, 200, 30]
const BLUE: [number, number, number] = [30, 30, 200]

const PAIR = {
  metadata: {
    device: { serial: "emulator-5554", model: "Pixel A", isEmulator: true },
    devices: [
      { name: "alice", serial: "emulator-5554", model: "Pixel A", isEmulator: true, platform: "android" as const },
      { name: "bob", serial: "emulator-5556", model: "Pixel B", isEmulator: true, platform: "android" as const },
    ],
    actionCount: 3,
  },
  events: [
    actionEvent({ actionIndex: 0, action: "tap", deviceId: "alice", selector: 'getByText("Send")', screenshots: { before: true } }),
    actionEvent({ actionIndex: 1, action: "tap", deviceId: "bob", selector: 'getByText("Inbox")', screenshots: { before: true } }),
    assertionEvent({ actionIndex: 2, assertion: "toBeVisible", deviceId: "alice", selector: 'getByText("Sent")' }),
  ],
  screenshots: {
    "screenshots/action-000-before.png": solidPng(SCREEN.width, SCREEN.height, RED),
    "screenshots/action-001-before.png": solidPng(SCREEN.width, SCREEN.height, BLUE),
    // alice's next capture: the assertion at index 2.
    "screenshots/action-002-before.png": solidPng(SCREEN.width, SCREEN.height, GREEN),
  },
}

/** The colour of the displayed screenshot's top-left pixel. */
async function displayedColor(page: Page): Promise<[number, number, number]> {
  return page.evaluate(async () => {
    const img = document.querySelector<HTMLImageElement>('img[alt^="Screenshot"]')
    if (!img) throw new Error("no screenshot displayed")
    if (!img.complete) await new Promise((r) => { img.onload = r })
    const canvas = document.createElement("canvas")
    canvas.width = 1
    canvas.height = 1
    canvas.getContext("2d")!.drawImage(img, 0, 0, 1, 1)
    const [r, g, b] = canvas.getContext("2d")!.getImageData(0, 0, 1, 1).data
    return [r, g, b] as [number, number, number]
  })
}

test.describe("Multi-device trace", () => {
  test("badges every row with the device that acted", async ({ viewer, actions }) => {
    await viewer.open(PAIR)
    await expect(actions.items).toHaveCount(3)
    await expect(actions.deviceTags).toHaveText(["alice", "bob", "alice"])
  })

  test("shows no badges on a single-device trace", async ({ viewer, actions }) => {
    await viewer.open({
      events: [actionEvent({ actionIndex: 0, action: "tap" })],
    })
    await expect(actions.items).toHaveCount(1)
    await expect(actions.deviceTags).toHaveCount(0)
  })

  test("lists every device in the Metadata tab and names them in the summary line", async ({ viewer, actions, filmstrip }) => {
    await viewer.open(PAIR)
    await expect(filmstrip.summary).toContainText("alice + bob")
    await actions.metadataTab.click()
    await expect(actions.metadataDevices).toHaveCount(2)
    await expect(actions.metadataDevices.nth(0)).toContainText("Pixel A")
    await expect(actions.metadataDevices.nth(0)).toContainText("emulator-5554")
    await expect(actions.metadataDevices.nth(1)).toContainText("Pixel B")
  })

  test("the Call tab names the device an action ran on", async ({ viewer, actions, detailTabs }) => {
    await viewer.open(PAIR)
    await actions.items.nth(1).click()
    await detailTabs.select("Call")
    await expect(detailTabs.callGrid).toContainText("bob")
    await expect(detailTabs.callGrid).toContainText("emulator-5556")
    await actions.items.nth(0).click()
    await expect(detailTabs.callGrid).toContainText("alice")
    await expect(detailTabs.callGrid).not.toContainText("emulator-5556")
  })

  test("the After stage shows the same device's next capture, not the other user's", async ({ viewer, actions, screenshotPanel, page }) => {
    await viewer.open(PAIR)
    await actions.items.nth(0).click()
    await screenshotPanel.selectStage("Before")
    expect(await displayedColor(page)).toEqual(RED)
    // Index 1 is bob's frame (blue); alice's state after her tap is index 2 (green).
    await screenshotPanel.selectStage("After")
    expect(await displayedColor(page)).toEqual(GREEN)
  })
})
