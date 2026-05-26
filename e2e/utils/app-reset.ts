import type { Device } from "tapsmith"
import { RESET_APP_DEEP_LINK } from "../reset-app-deep-link.mjs"

const RESET_APP_WAIT_MS = 750

export function resetAppDeepLink(path = "/") {
  const url = new URL(RESET_APP_DEEP_LINK)
  const targetPath = path.startsWith("/") ? path : `/${path}`
  if (targetPath !== "/") {
    url.searchParams.set("path", targetPath)
  }
  return url.toString()
}

export async function resetApp(device: Device, path = "/") {
  await device.openDeepLink(resetAppDeepLink(path))
  try {
    await device.waitForIdle(RESET_APP_WAIT_MS)
  } catch {
    await new Promise((resolve) => setTimeout(resolve, RESET_APP_WAIT_MS))
  }
}
