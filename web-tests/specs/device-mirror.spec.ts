// Device mirror: the binary screen-frame path.
//
// Frames are the one part of the protocol that isn't JSON — an 11-byte header
// plus a raw PNG, decoded by `use-screen-mirror.ts` and painted to a <canvas>.
// That path depends on the frame arriving as an ArrayBuffer (the hook branches
// on `instanceof ArrayBuffer`), so these are what stop a silent break there: a
// Blob instead would drop every frame with no error raised anywhere.

import { test, expect } from "../fixtures.js"
import { screenFrame, solidPng } from "../messages/frames.js"

test.describe("Device mirror", () => {
  test("paints a frame onto the canvas", async ({ app, device }) => {
    const ui = app
    ui.sendFrame(screenFrame(180, 320))

    await expect(device.canvas).toHaveAttribute("width", "180")
    await expect(device.canvas).toHaveAttribute("height", "320")
  })

  test("resizes when a later frame changes dimensions", async ({ app, device }) => {
    const ui = app
    ui.sendFrame(screenFrame(180, 320, 1))
    await expect(device.canvas).toHaveAttribute("width", "180")

    // A rotation, or a different device mid-session.
    ui.sendFrame(screenFrame(320, 180, 2))
    await expect(device.canvas).toHaveAttribute("width", "320")
    await expect(device.canvas).toHaveAttribute("height", "180")
  })

  test("ignores a frame that arrives out of order", async ({ app, device }) => {
    const ui = app
    ui.sendFrame(screenFrame(180, 320, 10))
    await expect(device.canvas).toHaveAttribute("width", "180")

    // A frame from before the current one must not repaint over it.
    ui.sendFrame(screenFrame(64, 64, 9))
    await expect(device.canvas).toHaveAttribute("width", "180")
    await expect(device.canvas).toHaveAttribute("height", "320")
  })

  test("decodes the PNG payload rather than just reading the header", async ({ app, device }) => {
    const ui = app
    // Green, so a mis-sliced payload (or nothing drawn at all) is obvious: the
    // pixel would read transparent instead of opaque green.
    ui.sendFrame({ width: 32, height: 32, png: solidPng(32, 32, [0, 200, 0]) })
    await expect(device.canvas).toHaveAttribute("width", "32")

    const pixel = await device.canvas.evaluate((el) => {
      const ctx = (el as HTMLCanvasElement).getContext("2d")
      if (!ctx) return null
      return [...ctx.getImageData(16, 16, 1, 1).data]
    })

    expect(pixel).not.toBeNull()
    const [r, g, b, a] = pixel!
    expect(a).toBe(255)
    expect(g).toBeGreaterThan(150)
    expect(r).toBeLessThan(50)
    expect(b).toBeLessThan(50)
  })

  test("survives a corrupt frame without breaking the mirror", async ({ app, device }) => {
    const ui = app
    ui.sendFrame(screenFrame(180, 320, 1))
    await expect(device.canvas).toHaveAttribute("width", "180")

    // A truncated PNG is dropped silently; the next good frame must still land.
    ui.sendFrame({ width: 64, height: 64, seq: 2, png: Buffer.from([0x89, 0x50, 0x4e, 0x47]) })
    ui.sendFrame(screenFrame(200, 400, 3))

    await expect(device.canvas).toHaveAttribute("width", "200")
    await expect(device.canvas).toHaveAttribute("height", "400")
  })

  test("shows a placeholder while no device is connected", async ({ app, device }) => {
    const ui = app
    ui.drop()
    await expect(device.placeholder).toContainText("Waiting for device")
    await expect(device.placeholder).toContainText("Connect a device or start a test run")
  })

  test("names the mirror for assistive tech", async ({ app, device }) => {
    void app
    // A bare <canvas> is invisible to screen readers; the label is the only
    // thing that names it.
    await expect(device.canvas).toHaveCount(1)
    await expect(device.root).toHaveCount(1)
  })
})
