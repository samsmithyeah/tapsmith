import { describe, expect, test } from "../fixtures.js"
import { openScreen } from "../utils/app-reset.js"

describe("Gestures screen", () => {
  test.beforeEach(async ({ device, gesturesScreen }) => {
    await openScreen(device, "/gestures")
    await expect(gesturesScreen.heading).toBeVisible()
  })

  test("shows heading and initial state", async ({ gesturesScreen }) => {
    await expect(gesturesScreen.heading).toBeVisible()
    await expect(gesturesScreen.lastGesture).toHaveText("Last gesture: None")
    await expect(gesturesScreen.tapCount).toHaveText("Tap count: 0")
  })

  // ─── Tap ───

  test("tap registers single tap", async ({ gesturesScreen }) => {
    await gesturesScreen.tapArea.tap()
    await expect(gesturesScreen.tapCount).toContainText("1")
  })

  // ─── Double Tap ───

  test("double tap registers double tap gesture", async ({ gesturesScreen }) => {
    await gesturesScreen.tapArea.doubleTap()
    await expect(gesturesScreen.lastGesture).toContainText("Double tap")
  })

  // ─── Long Press ───

  test("long press changes state", async ({ gesturesScreen }) => {
    await gesturesScreen.longPressArea.longPress()
    await expect(gesturesScreen.lastGesture).toHaveText("Last gesture: Long press")
  })

  test("long press with custom duration", async ({ gesturesScreen }) => {
    await gesturesScreen.longPressArea.tap()
    await gesturesScreen.longPressArea.longPress(2000)
    await expect(gesturesScreen.lastGesture).toHaveText("Last gesture: Long press")
  })

  // ─── Drag ───

  test("drag area is visible", async ({ gesturesScreen }) => {
    await expect(gesturesScreen.draggable).toBeVisible()
    await expect(gesturesScreen.dropZone).toBeVisible()
  })

  test("can drag element to drop zone", async ({ gesturesScreen }) => {
    await gesturesScreen.draggable.dragTo(gesturesScreen.dropZone)
    await expect(gesturesScreen.lastGesture).toHaveText("Last gesture: Drag")
  })

  // ─── Pinch ───

  test("pinch area is visible", async ({ gesturesScreen }) => {
    await expect(gesturesScreen.pinchArea).toBeVisible()
  })

  test("pinchIn gesture on pinch area", async ({ gesturesScreen }) => {
    await gesturesScreen.pinchArea.pinchIn({ scale: 0.5 })
  })

  test("pinchOut gesture on pinch area", async ({ gesturesScreen }) => {
    await gesturesScreen.pinchArea.pinchOut({ scale: 2.0 })
  })

  // ─── Swipe ───

  test("swipe area is visible", async ({ gesturesScreen }) => {
    await expect(gesturesScreen.swipeArea).toBeVisible()
  })

  // ─── Element Info ───

  test("draggable has correct bounding box", async ({ gesturesScreen }) => {
    const box = await gesturesScreen.draggable.boundingBox()
    expect(box).toBeDefined()
    expect(box!.width).toBeGreaterThan(0)
    expect(box!.height).toBeGreaterThan(0)
  })

  test("tap area isVisible returns true", async ({ gesturesScreen }) => {
    const visible = await gesturesScreen.tapArea.isVisible()
    expect(visible).toBe(true)
  })

  test("tap area isEnabled returns true", async ({ gesturesScreen }) => {
    const enabled = await gesturesScreen.tapArea.isEnabled()
    expect(enabled).toBe(true)
  })
})
