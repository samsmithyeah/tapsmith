import { beforeAll, contentDesc, describe, expect, id, role, test, text } from "pilot"

describe("Dialogs screen", () => {
  beforeAll(async ({ device }) => {
    await device.tap(contentDesc("Dialogs"))
  })

  test("shows heading", async ({ device }) => {
    await expect(device.element(text("Dialogs & Overlays"))).toBeVisible()
  })

  // ─── Toast ───

  test("show toast button is visible", async ({ device }) => {
    await expect(device.element(id("show-toast-button"))).toBeVisible()
  })

  test("tapping show toast displays a toast", async ({ device }) => {
    await device.tap(id("show-toast-button"))
    await expect(device.element(text("Item saved successfully!"))).toBeVisible()
  })

  test("error toast shows error message", async ({ device }) => {
    await device.tap(id("show-error-toast-button"))
    await expect(device.element(text("Something went wrong"))).toBeVisible()
  })

  // ─── Snackbar ───

  test("can show and dismiss snackbar", async ({ device }) => {
    await device.waitForIdle()
    await device.tap(id("show-snackbar-button"))
    await expect(device.element(text("Message archived"))).toBeVisible()
    await expect(device.element(text("DISMISS"))).toBeVisible()

    await device.tap(text("DISMISS"))
    await expect(device.element(id("snackbar"))).not.toBeVisible()
  })

  // ─── Modal ───

  test("can show and cancel modal", async ({ device }) => {
    await device.tap(id("show-modal-button"))
    await expect(device.element(text("Modal Title"))).toBeVisible()
    await expect(device.element(role("button", "Cancel"))).toBeVisible()
    await expect(device.element(role("button", "Confirm"))).toBeVisible()

    await device.tap(role("button", "Cancel"))
    await expect(device.element(id("modal"))).not.toBeVisible()
  })
})
