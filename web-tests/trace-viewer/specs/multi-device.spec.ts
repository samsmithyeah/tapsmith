// A trace recorded by a two-device test (`use.devices`): every event names the
// device that produced it and the metadata lists both devices. The viewer has
// to keep the two apart — which row ran where, whose pixel ratio to scale
// bounds by, and what "after" means when the next action belongs to the other
// user.

import { test, expect } from "../fixtures.js"
import { actionEvent, assertionEvent, consoleEvent, hierarchyXml, networkEntry } from "../trace-builder.js"
import { solidPng } from "../../png.js"
import type { Page } from "@playwright/test"

const SCREEN = { width: 240, height: 500 }
const RED: [number, number, number] = [200, 30, 30]
const GREEN: [number, number, number] = [30, 200, 30]
const BLUE: [number, number, number] = [30, 30, 200]
const YELLOW: [number, number, number] = [220, 200, 30]

const ALICE_TREE = hierarchyXml([
  { class: "android.widget.Button", text: "Send", desc: "Send", id: "dev.tapsmith.testapp:id/send", bounds: "[20,100][220,200]" },
])
const BOB_TREE = hierarchyXml([
  { class: "android.widget.TextView", text: "Inbox", desc: "Inbox", id: "dev.tapsmith.testapp:id/inbox", bounds: "[20,100][220,200]" },
])
const ALICE_AFTER_TREE = hierarchyXml([
  { class: "android.widget.TextView", text: "Sent", desc: "Sent", id: "dev.tapsmith.testapp:id/sent", bounds: "[20,100][220,200]" },
])

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
    actionEvent({ actionIndex: 0, action: "tap", deviceId: "alice", selector: 'getByText("Send")', screenshots: { before: true }, hierarchies: { before: true } }),
    actionEvent({ actionIndex: 1, action: "tap", deviceId: "bob", selector: 'getByText("Inbox")', screenshots: { before: true }, hierarchies: { before: true } }),
    assertionEvent({ actionIndex: 2, assertion: "toBeVisible", deviceId: "alice", selector: 'getByText("Sent")', hierarchies: { before: true } }),
    consoleEvent({ actionIndex: 0, level: "log", message: "alice booted", deviceId: "alice" }),
    consoleEvent({ actionIndex: 1, level: "log", message: "bob booted", deviceId: "bob" }),
    consoleEvent({ actionIndex: 1, level: "warn", message: "bob slow frame", deviceId: "bob", source: "daemon" }),
  ],
  screenshots: {
    "screenshots/action-000-before.png": solidPng(SCREEN.width, SCREEN.height, RED),
    "screenshots/action-001-before.png": solidPng(SCREEN.width, SCREEN.height, BLUE),
    // alice's next capture: the assertion at index 2.
    "screenshots/action-002-before.png": solidPng(SCREEN.width, SCREEN.height, GREEN),
    // The runner's end-of-test frames: one per device from `actionCount` on,
    // in group order (alice at 3, bob at 4). bob's is his only later frame.
    "screenshots/action-003-before.png": solidPng(SCREEN.width, SCREEN.height, GREEN),
    "screenshots/action-004-before.png": solidPng(SCREEN.width, SCREEN.height, YELLOW),
  },
  hierarchies: {
    "hierarchy/action-000-before.xml": ALICE_TREE,
    "hierarchy/action-001-before.xml": BOB_TREE,
    "hierarchy/action-002-before.xml": ALICE_AFTER_TREE,
  },
  network: [
    networkEntry({ index: 0, url: "https://chat.example/messages?who=alice", status: 200, deviceId: "alice" }),
    networkEntry({ index: 1, url: "https://chat.example/messages?who=bob", status: 200, deviceId: "bob" }),
  ],
}

/** The colour of one pane's displayed screenshot at its top-left pixel. */
async function paneColor(page: Page, device: string): Promise<[number, number, number]> {
  return page.evaluate(async (device) => {
    const img = document.querySelector<HTMLImageElement>(`[data-testid="screenshot-pane"][data-device="${device}"] img[alt^="Screenshot"]`)
    if (!img) throw new Error(`no screenshot displayed for ${device}`)
    if (!img.complete) await new Promise((r) => { img.onload = r })
    const canvas = document.createElement("canvas")
    canvas.width = 1
    canvas.height = 1
    canvas.getContext("2d")!.drawImage(img, 0, 0, 1, 1)
    const [r, g, b] = canvas.getContext("2d")!.getImageData(0, 0, 1, 1).data
    return [r, g, b] as [number, number, number]
  }, device)
}

/** Click a pane's screenshot at the centre of a node's captured bounds. */
async function clickPaneBounds(image: import("@playwright/test").Locator, bounds: { left: number; top: number; right: number; bottom: number }) {
  const box = await image.boundingBox()
  if (!box) throw new Error("pane screenshot is not visible")
  const fx = (bounds.left + bounds.right) / 2 / SCREEN.width
  const fy = (bounds.top + bounds.bottom) / 2 / SCREEN.height
  await image.page().mouse.click(box.x + box.width * fx, box.y + box.height * fy)
}
const NODE_BOUNDS = { left: 20, top: 100, right: 220, bottom: 200 }

/** The colour of the displayed screenshot's top-left pixel. */
async function displayedColor(page: Page): Promise<[number, number, number]> {
  return page.evaluate(async () => {
    const img = document.querySelector<HTMLImageElement>('[data-testid="screenshot-pane"][data-acting="true"] img[alt^="Screenshot"]')
      ?? document.querySelector<HTMLImageElement>('img[alt^="Screenshot"]')
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

  test.describe("Side-by-side panes", () => {
    test("shows one pane per device, marking the one that acted", async ({ viewer, actions, screenshotPanel }) => {
      await viewer.open(PAIR)
      await actions.items.nth(1).click()
      await expect(screenshotPanel.panes).toHaveCount(2)
      await expect(screenshotPanel.pane("bob")).toHaveAttribute("data-acting", "true")
      await expect(screenshotPanel.paneRole("bob")).toHaveText("acting")
      await expect(screenshotPanel.pane("alice")).toHaveAttribute("data-acting", "false")
    })

    test("the other device shows its own state at that moment", async ({ viewer, actions, screenshotPanel, page }) => {
      await viewer.open(PAIR)
      // bob's tap: bob's pane is his frame (blue); alice's pane is her latest
      // capture before it (red), not bob's frame.
      await actions.items.nth(1).click()
      await expect(screenshotPanel.paneImage("bob")).toBeVisible()
      // Polled: a stage switch swaps the image src, and the pixel read must
      // wait for the new frame rather than sample the outgoing one.
      await expect.poll(() => paneColor(page, "bob")).toEqual(BLUE)
      await expect.poll(() => paneColor(page, "alice")).toEqual(RED)
      // After the step, alice's pane advances to her next capture (green) and
      // bob's to his end-of-test frame (yellow), his only later capture.
      await screenshotPanel.selectStage("After")
      await expect.poll(() => paneColor(page, "alice")).toEqual(GREEN)
      await expect.poll(() => paneColor(page, "bob")).toEqual(YELLOW)
    })

    test("a single-device trace keeps the single image", async ({ viewer, screenshotPanel }) => {
      await viewer.open({
        events: [actionEvent({ actionIndex: 0, action: "tap", screenshots: { before: true } })],
        screenshots: { "screenshots/action-000-before.png": solidPng(SCREEN.width, SCREEN.height, RED) },
      })
      await expect(screenshotPanel.image).toBeVisible()
      await expect(screenshotPanel.panes).toHaveCount(0)
    })

    test("clicking another pane selects it, and a pick then targets that device", async ({ viewer, actions, screenshotPanel, detailTabs, locator, page }) => {
      await viewer.open(PAIR)
      await actions.items.nth(0).click()
      await expect(screenshotPanel.paneRole("alice")).toHaveText("acting")
      await expect(screenshotPanel.paneRole("bob")).toHaveCount(0)

      await page.getByRole("button", { name: "Pick", exact: true }).click()
      // First click on bob's pane only moves the selection there.
      await screenshotPanel.paneImage("bob").click()
      await expect(screenshotPanel.paneRole("bob")).toHaveText("selected")
      await expect(page.getByRole("button", { name: "Picking…", exact: true })).toBeVisible()

      // The pick hit-tests bob's tree at his displayed frame (the Inbox
      // label), not alice's Send button under the same coordinates.
      await clickPaneBounds(screenshotPanel.paneImage("bob"), NODE_BOUNDS)
      await detailTabs.select("Locator")
      await expect(locator.suggestions).toContainText("Inbox")
      await expect(locator.suggestions).not.toContainText("Send")
    })

    test("picking on the acting pane uses that device's tree", async ({ viewer, actions, screenshotPanel, detailTabs, locator, page }) => {
      await viewer.open(PAIR)
      await actions.items.nth(0).click()
      await page.getByRole("button", { name: "Pick", exact: true }).click()
      await clickPaneBounds(screenshotPanel.paneImage("alice"), NODE_BOUNDS)
      await detailTabs.select("Locator")
      await expect(locator.suggestions).toContainText("Send")
      await expect(locator.suggestions).not.toContainText("Inbox")
    })
  })

  test.describe("Per-device filters", () => {
    test("the Console tab offers one pill per device", async ({ viewer, actions, detailTabs }) => {
      await viewer.open(PAIR)
      await actions.items.nth(0).click()
      await detailTabs.select("Console")
      await expect(detailTabs.consoleEntries).toHaveCount(3)

      await detailTabs.consoleDevicePill("bob").click()
      await expect(detailTabs.consoleDevicePill("bob")).toHaveAttribute("aria-pressed", "true")
      await expect(detailTabs.consoleEntries).toHaveCount(2)
      await expect(detailTabs.consoleOutput).toContainText("bob booted")
      await expect(detailTabs.consoleOutput).not.toContainText("alice booted")

      await detailTabs.consoleDevicePill("alice").click()
      await expect(detailTabs.consoleEntries).toHaveCount(1)
      await expect(detailTabs.consoleOutput).toContainText("alice booted")
    })

    test("the Hierarchy tab defaults to the acting device and can view the other", async ({ viewer, actions, detailTabs, page }) => {
      await viewer.open(PAIR)
      await actions.items.nth(1).click()
      await detailTabs.select("Hierarchy")
      await expect(detailTabs.hierarchyDevicePill("bob")).toHaveAttribute("aria-pressed", "true")
      await expect(page.getByRole("tree")).toContainText("Inbox")

      await detailTabs.hierarchyDevicePill("alice").click()
      await expect(detailTabs.hierarchyDevicePill("alice")).toHaveAttribute("aria-pressed", "true")
      // alice's state after bob's tap is her next capture: the "Sent" tree.
      await expect(page.getByRole("tree")).toContainText("Sent")
      await expect(page.getByRole("tree")).not.toContainText("Inbox")
    })

    test("the Network tab names each request's device and filters by it", async ({ viewer, detailTabs, network }) => {
      await viewer.open(PAIR)
      await detailTabs.select("Network")
      await expect(network.rows).toHaveCount(2)
      await expect(network.columnHeaders).toContainText(["Name", "Device"])
      await expect(network.row("who=alice").getByTestId("net-device")).toHaveText("alice")

      await network.pill("bob").click()
      await expect(network.rows).toHaveCount(1)
      await expect(network.rows.first()).toContainText("who=bob")
      await network.pill("All devices").click()
      await expect(network.rows).toHaveCount(2)
    })

    test("a single-device trace shows no device pills or column", async ({ viewer, detailTabs, network, actions }) => {
      await viewer.open({
        events: [
          actionEvent({ actionIndex: 0, action: "tap" }),
          consoleEvent({ actionIndex: 0, level: "log", message: "booted" }),
        ],
        network: [networkEntry({ index: 0, url: "https://chat.example/messages", status: 200 })],
      })
      await actions.items.nth(0).click()
      await detailTabs.select("Console")
      await expect(detailTabs.consoleDevicePill("alice")).toHaveCount(0)
      await detailTabs.select("Network")
      await expect(network.columnHeaders).not.toContainText(["Device"])
      await expect(network.pill("All devices")).toHaveCount(0)
    })
  })

  test.describe("Filmstrip lanes", () => {
    test("splits the strip into one lane per device", async ({ viewer, filmstrip }) => {
      await viewer.open(PAIR)
      await expect(filmstrip.lanes).toHaveCount(2)
      await expect(filmstrip.laneLabels).toHaveText(["alice", "bob"])
      await expect(filmstrip.laneFrames("alice")).toHaveCount(2)
      await expect(filmstrip.laneFrames("bob")).toHaveCount(1)
    })

    test("the lanes stay inside the strip and leave the panels clickable", async ({ viewer, actions, filmstrip, page }) => {
      await viewer.open(PAIR)
      const strip = await filmstrip.lanes.first().locator("..").boundingBox()
      const header = await page.getByTestId("timeline-meta").boundingBox()
      const tab = await actions.metadataTab.boundingBox()
      expect(strip && header && tab).toBeTruthy()
      // Two lanes must not push past the row the strip is given; the metadata
      // tab below would otherwise sit under a thumbnail and swallow clicks.
      expect(strip!.y + strip!.height).toBeLessThanOrEqual(tab!.y + 1)
      await actions.metadataTab.click({ timeout: 3_000 })
      await expect(actions.metadataDevices).toHaveCount(2)
    })

    test("a single-device trace has no lanes", async ({ viewer, filmstrip }) => {
      await viewer.open({ events: [actionEvent({ actionIndex: 0, action: "tap" })] })
      await expect(filmstrip.frames).toHaveCount(1)
      await expect(filmstrip.lanes).toHaveCount(0)
    })
  })
})
