import type { Device } from "tapsmith"
import { RESET_APP_DEEP_LINK } from "../reset-app-deep-link.mjs"

export function resetAppDeepLink(path = "/") {
  const url = new URL(RESET_APP_DEEP_LINK)
  if (path !== "/") {
    url.searchParams.set("path", path)
  }
  return url.toString()
}

export async function resetApp(device: Device, path = "/") {
  await device.openDeepLink(resetAppDeepLink(path))
}
