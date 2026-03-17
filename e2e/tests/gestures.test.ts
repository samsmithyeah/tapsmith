import { contentDesc, describe, expect, id, test, text } from "pilot"

describe("Gestures screen", () => {
  test("navigate to gestures screen", async ({ device }) => {
    await device.tap(contentDesc("Gestures"))
  })

  test("shows heading and initial state", async ({ device }) => {
    await expect(device.element(text("Gesture Testing"))).toBeVisible()
    await expect(device.element(id("last-gesture"))).toHaveText("Last gesture: None")
    await expect(device.element(id("tap-count"))).toHaveText("Tap count: 0")
  })

  // ─── Tap ───

  test("tap registers single tap", async ({ device }) => {
    await device.tap(id("tap-area"))
    await expect(device.element(id("tap-count"))).toContainText("1")
  })

  // ─── Double Tap ───

  test("double tap registers double tap gesture", async ({ device }) => {
    await device.doubleTap(id("tap-area"))
    await expect(device.element(id("last-gesture"))).toContainText("Double tap")
  })

  // ─── Long Press ───

  test("long press changes state", async ({ device }) => {
    await device.longPress(id("long-press-area"))
    await expect(device.element(id("last-gesture"))).toHaveText("Last gesture: Long press")
    await expect(device.element(text("Long pressed!"))).toBeVisible()
  })

  test("long press with custom duration", async ({ device }) => {
    // Reset by tapping
    await device.tap(id("long-press-area"))
    await device.longPress(id("long-press-area"), 2000)
    await expect(device.element(text("Long pressed!"))).toBeVisible()
  })

  // ─── Drag ───

  test("drag area is visible", async ({ device }) => {
    await expect(device.element(id("draggable"))).toBeVisible()
    await expect(device.element(id("drop-zone"))).toBeVisible()
  })

  test("can drag element to drop zone", async ({ device }) => {
    await device.drag({
      from: id("draggable"),
      to: id("drop-zone"),
    })
    await expect(device.element(id("last-gesture"))).toHaveText("Last gesture: Drag")
  })

  // ─── Pinch ───

  test("pinch area is visible", async ({ device }) => {
    await expect(device.element(id("pinch-area"))).toBeVisible()
  })

  test("pinchIn gesture on pinch area", async ({ device }) => {
    await device.pinchIn(id("pinch-area"), { scale: 0.5 })
  })

  test("pinchOut gesture on pinch area", async ({ device }) => {
    await device.pinchOut(id("pinch-area"), { scale: 2.0 })
  })

  // ─── Swipe ───

  test("swipe area is visible", async ({ device }) => {
    await expect(device.element(id("swipe-area"))).toBeVisible()
  })

  // ─── Element Info ───

  test("draggable has correct bounding box", async ({ device }) => {
    const box = await device.element(id("draggable")).boundingBox()
    expect(box).toBeDefined()
    expect(box!.width).toBeGreaterThan(0)
    expect(box!.height).toBeGreaterThan(0)
  })

  test("tap area isVisible returns true", async ({ device }) => {
    const visible = await device.element(id("tap-area")).isVisible()
    expect(visible).toBe(true)
  })

  test("tap area isEnabled returns true", async ({ device }) => {
    const enabled = await device.element(id("tap-area")).isEnabled()
    expect(enabled).toBe(true)
  })
})
