import { describe, expect, test } from "../fixtures.js"

/**
 * End-to-end smoke test for the streamed-touch (live-drag) path that powers the
 * interactive mirror: device._client.touchDown → touchMove* → touchUp drives a
 * real gesture through the daemon to the on-device agent (Android injects live;
 * iOS buffers + replays on touchUp). We assert a scrollable item physically
 * moves up — proving the streamed gesture scrolled the view.
 */
describe("Live touch stream", () => {
  test("streamed drag scrolls the view", async ({ device, scrollScreen }) => {
    await device.openDeepLink("tapsmithtest:///scroll")
    await expect(scrollScreen.firstItem).toBeVisible()

    const before = await scrollScreen.firstItem.boundingBox()
    if (!before) throw new Error("first item has no bounds")
    const cx = before.x + before.width / 2
    const startY = before.y + before.height / 2

    // Stream an upward drag (scrolls the list down) as down → moves → up.
    // The touch-up deliberately reuses the last move's offset AND point — a
    // degenerate, non-monotonic path that the agent's swipePath must normalise
    // (else XCPointerEventPath yields a no-op gesture and the list won't move).
    // @ts-expect-error internal gRPC client access for the smoke test
    const c = device._client
    await c.touchDown(cx, startY)
    const steps = 10
    for (let i = 1; i <= steps; i++) {
      await c.touchMove(cx, startY - i * 25, i * 20)
    }
    await c.touchUp(cx, startY - steps * 25, steps * 20)

    // Let any momentum settle, then confirm the item scrolled upward.
    await new Promise((r) => setTimeout(r, 1000))
    const after = await scrollScreen.firstItem.boundingBox()
    if (!after) {
      // Scrolled fully out of view — that's an even stronger proof of scrolling.
      return
    }
    expect(after.y).toBeLessThan(before.y)
  })
})
