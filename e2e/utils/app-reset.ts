import type { Device } from "tapsmith"
import { RESET_APP_DEEP_LINK } from "../reset-app-deep-link.mjs"

/**
 * The legacy explicit reset route (`/__reset?path=…`). Only the
 * `resetAppDeepLink` configuration in `tapsmith.config.ios-mixed.mjs` still
 * uses it; everything else goes through the in-app hooks.
 */
export function resetAppDeepLink(path = "/") {
  const url = new URL(RESET_APP_DEEP_LINK)
  const targetPath = path.startsWith("/") ? path : `/${path}`
  if (targetPath !== "/") {
    url.searchParams.set("path", targetPath)
  }
  return url.toString()
}

/**
 * Navigate to `path` without resetting. Use this right after Tapsmith's own
 * declared app reset (scope entry / before each test — see `appReset` in
 * docs/writing-tests.md): the app is freshly reset at its launch route, so all
 * a hook has to do is open the screen under test.
 */
export async function openScreen(device: Device, path: string) {
  const target = path.startsWith("/") ? path : `/${path}`
  await device.openDeepLink(`tapsmithtest://${target}`)
}

/**
 * Reset the app *again*, mid-test, and land on `path`. Only for tests that
 * need a second reset inside one test (e.g. clearing UI state while keeping
 * network routes registered) — hooks should use `openScreen` instead. Runs the daemon's reset ladder: a warm,
 * acknowledged in-app reset via `@tapsmith/react-native` when the app
 * advertises it, falling back to a restart or a clear. Only the warm rung
 * carries the route (it is the deep link itself); after a fallback the app is
 * at its launch route, so navigate explicitly.
 */
export async function resetApp(device: Device, path = "/") {
  const target = path.startsWith("/") ? path : `/${path}`
  const result = await device.resetApp({ target })
  if (result.modeUsed !== "warm" && target !== "/") {
    await device.openDeepLink(`tapsmithtest://${target}`)
  }
}
