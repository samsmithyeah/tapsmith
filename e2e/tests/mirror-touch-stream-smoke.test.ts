import { describe, expect, test } from "../fixtures.js"
import { openScreen } from "../utils/app-reset.js"

/**
 * End-to-end smoke test for the streamed-touch (live-drag) path that powers the
 * interactive mirror: device._client.touchDown → touchMove* → touchUp drives a
 * real gesture through the daemon to the on-device agent (Android injects live;
 * iOS buffers + replays on touchUp). We assert a scrollable item physically
 * moves up — proving the streamed gesture scrolled the view.
 */
describe("Live touch stream", () => {
  test("streamed drag scrolls the view", async ({ device, scrollScreen }) => {
    // The declared app reset has just put the app at its launch route; all
    // that is left is opening the scroll screen.
