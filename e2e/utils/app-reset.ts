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
 * Reset the app and land on `path`. Runs the daemon's reset ladder: a warm,
 * acknowledged in-app reset via `@tapsmith/react-native` when the app
 * advertises it, falling back to a restart or a clear.
 */
export async function resetApp(device: Device, path = "/") {
  await device.resetApp({ target: path.startsWith("/") ? path : `/${path}` })
}
