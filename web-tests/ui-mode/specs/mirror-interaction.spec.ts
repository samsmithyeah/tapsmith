// Driving the device through the mirror: taps, long presses, swipes and typing.
//
// Coordinates go over the wire normalised to 0–1 against the rendered canvas
// (`normalizePoint` in use-device-interaction.ts), so the maths is worth pinning
// — a wrong divisor taps the wrong place on a real device.

import { test, expect } from "../fixtures.js"
import { screenFrame } from "../messages/frames.js"

/** Paint the mirror so it has a laid-out canvas to interact with. */
async function paint(ui: { sendFrame: (f: ReturnType<typeof screenFrame>) => void }) {
  ui.sendFrame(screenFrame(240, 500))
}

test.describe("Device mirror interaction", () => {
  test("starts unlocked and can be locked", async ({ app, device }) => {
    void app
    await expect(device.lockToggle).toHaveAccessibleName(/^Interaction unlocked/)
    await device.lockToggle.click()
    await expect(device.lockToggle).toHaveAccessibleName(/^Interaction locked/)
  })

  test("a click sends a tap with normalised coordinates", async ({ app, device }) => {
    const ui = app
    await paint(ui)
    await expect(device.canvas).toHaveAttribute("width", "240")

    await device.tapMirrorAt(0.5, 0.25)

    const msg = await ui.waitForMessage("mirror-tap")
    // Normalised against the canvas box, so the middle is 0.5 whatever the
    // rendered size.
    expect(msg.x).toBeGreaterThan(0.45)
    expect(msg.x).toBeLessThan(0.55)
    expect(msg.y).toBeGreaterThan(0.2)
    expect(msg.y).toBeLessThan(0.3)
  })

  test("taps at a corner stay within 0–1", async ({ app, device }) => {
    const ui = app
    await paint(ui)
    await device.tapMirrorAt(0.02, 0.02)

    const msg = await ui.waitForMessage("mirror-tap")
    expect(msg.x).toBeGreaterThanOrEqual(0)
    expect(msg.y).toBeGreaterThanOrEqual(0)
    expect(msg.x).toBeLessThan(0.1)
    expect(msg.y).toBeLessThan(0.1)
  })

  test("sends nothing while locked", async ({ app, device, page }) => {
    const ui = app
    await paint(ui)
    await device.lockToggle.click()
    await expect(device.lockToggle).toHaveAccessibleName(/^Interaction locked/)
    ui.clearReceived()

    await device.tapMirrorAt(0.5, 0.5)
    await page.waitForTimeout(300)

    // A locked mirror is read-only; a stray click must not reach the device.
    expect(ui.messagesOfType("mirror-tap")).toEqual([])
  })

  test("a drag sends a swipe", async ({ app, device, page }) => {
    const ui = app
    await paint(ui)

    const box = await device.canvas.boundingBox()
    if (!box) throw new Error("no canvas")
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.8)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.2, { steps: 8 })
    await page.mouse.up()

    // A drag is streamed as a touch sequence, ending in a touch-end.
    await ui.waitForMessage("mirror-touch-start")
    await ui.waitForMessage("mirror-touch-end")
    expect(ui.messagesOfType("mirror-touch-move").length).toBeGreaterThan(0)
  })

  test("a long press sends a long press", async ({ app, device, page }) => {
    const ui = app
    await paint(ui)

    const box = await device.canvas.boundingBox()
    if (!box) throw new Error("no canvas")
    const x = box.x + box.width * 0.5
    const y = box.y + box.height * 0.5

    await page.mouse.move(x, y)
    await page.mouse.down()
    // LONG_PRESS_MS is 500 in use-device-interaction.ts.
    await page.waitForTimeout(700)
    await page.mouse.up()

    await ui.waitForMessage("mirror-long-press")
  })

  test("typing on a focused mirror sends text", async ({ app, device }) => {
    const ui = app
    await paint(ui)

    // A tap focuses the canvas, which is what routes keystrokes to the device.
    await device.tapMirrorAt(0.5, 0.5)
    await device.canvas.press("h")
    await device.canvas.press("i")

    const msg = await ui.waitForMessage("mirror-input-text")
    expect(msg.text).toBe("h")
  })

  test("a named key is sent as a key press, not text", async ({ app, device }) => {
    const ui = app
    await paint(ui)
    await device.tapMirrorAt(0.5, 0.5)

    await device.canvas.press("Enter")
    const msg = await ui.waitForMessage("mirror-press-key")
    expect(msg.key).toBe("Enter")
  })

  test("pick mode does not tap the device", async ({ app, device, page }) => {
    const ui = app
    await paint(ui)
    await expect(device.pickToggle).toBeEnabled()

    await device.enablePickMode()
    ui.clearReceived()
    await device.tapMirrorAt(0.5, 0.5)
    await page.waitForTimeout(300)

    // Picking is read-only: the click selects an element instead of tapping,
    // even though the mirror is unlocked.
    expect(ui.messagesOfType("mirror-tap")).toEqual([])
  })

  test("asks the server for a hierarchy when picking starts", async ({ app, device }) => {
    const ui = app
    await paint(ui)
    await device.enablePickMode()
    await ui.waitForMessage("request-hierarchy")
  })
})
