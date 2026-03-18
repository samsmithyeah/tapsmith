import { beforeAll, contentDesc, describe, expect, id, test, text } from "pilot"
import { GesturesScreen } from "../screens/gestures.screen.js"

describe("Gestures screen", () => {
  beforeAll(async ({ device }) => {
    await device.tap(contentDesc("Gestures"))
  })

  test("shows heading and initial state", async ({ device }) => {
    await expect(device.element(text("Gesture Testing"))).toBeVisible()
    const screen = new GesturesScreen(device)
    await expect(screen.lastGesture).toHaveText("Last gesture: None")
    await expect(screen.tapCount).toHaveText("Tap count: 0")
  })

  // ─── Tap ───

  test("tap registers single tap", async ({ device }) => {
    const screen = new GesturesScreen(device)
    await screen.tapArea.tap()
    await expect(screen.tapCount).toContainText("1")
  })

  // ─── Double Tap ───

  test("double tap registers double tap gesture", async ({ device }) => {
    const screen = new GesturesScreen(device)
    await device.doubleTap(id("tap-area"))
    await expect(screen.lastGesture).toContainText("Double tap")
  })

  // ─── Long Press ───

  test("long press changes state", async ({ device }) => {
    const screen = new GesturesScreen(device)
    await device.longPress(id("long-press-area"))
    await expect(screen.lastGesture).toHaveText("Last gesture: Long press")
    await expect(screen.longPressedText).toBeVisible()
  })

  test("long press with custom duration", async ({ device }) => {
    const screen = new GesturesScreen(device)
    // Reset by tapping
    await screen.longPressArea.tap()
    await device.longPress(id("long-press-area"), 2000)
    await expect(screen.longPressedText).toBeVisible()
  })

  // ─── Drag ───

  test("drag area is visible", async ({ device }) => {
    const screen = new GesturesScreen(device)
    await expect(screen.draggable).toBeVisible()
    await expect(screen.dropZone).toBeVisible()
  })

  test("can drag element to drop zone", async ({ device }) => {
    const screen = new GesturesScreen(device)
    await device.drag({
      from: id("draggable"),
      to: id("drop-zone"),
    })
    await expect(screen.lastGesture).toHaveText("Last gesture: Drag")
  })

  // ─── Pinch ───

  test("pinch area is visible", async ({ device }) => {
    const screen = new GesturesScreen(device)
    await expect(screen.pinchArea).toBeVisible()
  })

  test("pinchIn gesture on pinch area", async ({ device }) => {
    await device.pinchIn(id("pinch-area"), { scale: 0.5 })
  })

  test("pinchOut gesture on pinch area", async ({ device }) => {
    await device.pinchOut(id("pinch-area"), { scale: 2.0 })
  })

  // ─── Swipe ───

  test("swipe area is visible", async ({ device }) => {
    const screen = new GesturesScreen(device)
    await expect(screen.swipeArea).toBeVisible()
  })

  // ─── Element Info ───

  test("draggable has correct bounding box", async ({ device }) => {
    const screen = new GesturesScreen(device)
    const box = await screen.draggable.boundingBox()
    expect(box).toBeDefined()
    expect(box!.width).toBeGreaterThan(0)
    expect(box!.height).toBeGreaterThan(0)
  })

  test("tap area isVisible returns true", async ({ device }) => {
    const screen = new GesturesScreen(device)
    const visible = await screen.tapArea.isVisible()
    expect(visible).toBe(true)
  })

  test("tap area isEnabled returns true", async ({ device }) => {
    const screen = new GesturesScreen(device)
    const enabled = await screen.tapArea.isEnabled()
    expect(enabled).toBe(true)
  })
})
