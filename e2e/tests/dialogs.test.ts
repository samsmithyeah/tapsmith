import { beforeAll, contentDesc, describe, expect, test, text } from "pilot"
import { DialogsScreen } from "../screens/dialogs.screen.js"

describe("Dialogs screen", () => {
  beforeAll(async ({ device }) => {
    await device.tap(contentDesc("Dialogs"))
  })

  test("shows heading", async ({ device }) => {
    await expect(device.element(text("Dialogs & Overlays"))).toBeVisible()
  })

  // ─── Toast ───

  test("show toast button is visible", async ({ device }) => {
    const screen = new DialogsScreen(device)
    await expect(screen.showToastButton).toBeVisible()
  })

  test("tapping show toast displays a toast", async ({ device }) => {
    const screen = new DialogsScreen(device)
    await screen.showToastButton.tap()
    await expect(screen.toastSuccess).toBeVisible()
  })

  test("error toast shows error message", async ({ device }) => {
    const screen = new DialogsScreen(device)
    await screen.showErrorToastButton.tap()
    await expect(screen.toastError).toBeVisible()
  })

  // ─── Snackbar ───

  test("can show and dismiss snackbar", async ({ device }) => {
    const screen = new DialogsScreen(device)
    await device.waitForIdle()
    await screen.showSnackbarButton.tap()
    await expect(screen.snackbarMessage).toBeVisible()
    await expect(screen.snackbarDismiss).toBeVisible()

    await screen.snackbarDismiss.tap()
    await expect(screen.snackbar).not.toBeVisible()
  })

  // ─── Modal ───

  test("can show and cancel modal", async ({ device }) => {
    const screen = new DialogsScreen(device)
    await screen.showModalButton.tap()
    await expect(screen.modalTitle).toBeVisible()
    await expect(screen.cancelButton).toBeVisible()
    await expect(screen.confirmButton).toBeVisible()

    await screen.cancelButton.tap()
    await expect(screen.modal).not.toBeVisible()
  })
})
