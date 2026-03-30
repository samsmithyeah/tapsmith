import { type Device, id, role, text } from "pilot"

export class DialogsScreen {
  constructor(private device: Device) {}

  // Toast
  get showToastButton() { return this.device.element(id("show-toast-button")) }
  get showErrorToastButton() { return this.device.element(id("show-error-toast-button")) }
  get toastSuccess() { return this.device.element(text("Item saved successfully!")) }
  get toastError() { return this.device.element(text("Something went wrong")) }

  // Snackbar
  get showSnackbarButton() { return this.device.element(id("show-snackbar-button")) }
  get snackbar() { return this.device.element(id("snackbar")) }
  get snackbarMessage() { return this.device.element(text("Message archived")) }
  get snackbarDismiss() { return this.device.element(text("DISMISS")) }

  // Modal
  get showModalButton() { return this.device.element(id("show-modal-button")) }
  get modal() { return this.device.element(id("modal")) }
  get modalTitle() { return this.device.element(text("Modal Title")) }
  get cancelButton() { return this.device.element(role("button", "Cancel")) }
  get confirmButton() { return this.device.element(role("button", "Confirm")) }
}
