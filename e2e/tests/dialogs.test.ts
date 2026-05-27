import { describe, expect, test } from "../fixtures.js"
import { resetApp } from "../utils/app-reset.js"

describe("Dialogs screen", () => {
  test.beforeEach(async ({ device, dialogsScreen }) => {
    await resetApp(device, "/dialogs")
    await expect(dialogsScreen.heading).toBeVisible()
  })

  // ─── Toast ───

  test("tapping show toast displays a toast", async ({ dialogsScreen }) => {
    await dialogsScreen.showToastButton.tap()
    await expect(dialogsScreen.toastSuccess).toBeVisible()
  })

  test("error toast shows error message", async ({ dialogsScreen }) => {
    await dialogsScreen.showErrorToastButton.tap()
    await expect(dialogsScreen.toastError).toBeVisible()
  })

  // ─── Snackbar ───

  test("can show and dismiss snackbar", async ({ dialogsScreen }) => {
    await dialogsScreen.showSnackbarButton.tap()
    await expect(dialogsScreen.snackbarMessage).toBeVisible()
    await expect(dialogsScreen.snackbarDismiss).toBeVisible()

    await dialogsScreen.snackbarDismiss.tap()
    await expect(dialogsScreen.snackbar).not.toBeVisible()
  })

  // ─── Modal ───

  test("can show and cancel modal", async ({ dialogsScreen }) => {
    await dialogsScreen.showModalButton.tap()
    await expect(dialogsScreen.modalTitle).toBeVisible()
    await expect(dialogsScreen.cancelButton).toBeVisible()
    await expect(dialogsScreen.confirmButton).toBeVisible()

    await dialogsScreen.cancelButton.tap()
    await expect(dialogsScreen.modal).not.toBeVisible()
  })
})
