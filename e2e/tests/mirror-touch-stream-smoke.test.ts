import { describe, expect, test } from "../fixtures.js"
import { resetApp } from "../utils/app-reset.js"

/**
 * End-to-end smoke test for the streamed-touch (live-drag) path that powers the
 * interactive mirror: device._client.touchDown → touchMove* → touchUp drives a
 * real gesture through the daemon to the on-device agent (Android injects live;
 * iOS buffers + replays on touchUp). We assert a scrollable item physically
 * moves up — proving the streamed gesture scrolled the view.
 */
describe("Live touch stream", () => {
  test("streamed drag scrolls the view", async ({ device, scrollScreen }) => {
    // Use resetApp (not a bare openDeepLink): when this runs after other tests
    // the app is already foregrounded on another screen, where a plain deep link
    // doesn't reliably re-navigate. resetApp resets to the scroll screen and
    // waits for idle, matching the other gesture/scroll smoke tests.
    await resetApp(device, "/scroll")
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
    // The drag may scroll Item A-1 fully out of view — strongest proof it
    // scrolled. Android's live MotionEvents fling farther than iOS's buffered
    // replay, so it often leaves the viewport entirely. boundingBox() waits for
    // the element to exist and THROWS when it's gone (it never returns null for
    // a missing element), so probe presence with count() first.
    const stillPresent = (await scrollScreen.firstItem.count()) > 0
    if (!stillPresent) {
      return // scrolled out of view — drag worked
    }
    const after = await scrollScreen.firstItem.boundingBox()
    if (!after) {
      return // present but unbounded (off-screen) — also proof it scrolled
    }
    expect(after.y).toBeLessThan(before.y)
  })
})
