import { Device } from "pilot"

export class DialogsScreen {
  constructor(private device: Device) {}

  // Toast
  get showToastButton() { return this.device.locator({ id: "show-toast-button" }) }
  get showErrorToastButton() { return this.device.locator({ id: "show-error-toast-button" }) }
  get toastSuccess() { return this.device.getByText("Item saved successfully!", { exact: true }) }
  get toastError() { return this.device.getByText("Something went wrong", { exact: true }) }

  // Snackbar
  get showSnackbarButton() { return this.device.locator({ id: "show-snackbar-button" }) }
  get snackbar() { return this.device.locator({ id: "snackbar" }) }
  get snackbarMessage() { return this.device.getByText("Message archived", { exact: true }) }
  get snackbarDismiss() { return this.device.getByRole("button", { name: "Dismiss" }) }

  // Modal
  get showModalButton() { return this.device.locator({ id: "show-modal-button" }) }
  get modal() { return this.device.locator({ id: "modal" }) }
  get modalTitle() { return this.device.getByText("Modal Title", { exact: true }) }
  get cancelButton() { return this.device.getByRole("button", { name: "Cancel" }) }
  get confirmButton() { return this.device.getByRole("button", { name: "Confirm" }) }
}
