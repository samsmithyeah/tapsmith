import { Device } from "tapsmith"

export class DialogsScreen {
  constructor(private device: Device) {}

  get heading() { return this.device.getByText("Dialogs & Overlays", { exact: true }) }

  // Toast
  get showToastButton() { return this.device.getByRole("button", { name: "Show toast" }) }
  get showErrorToastButton() { return this.device.getByRole("button", { name: "Show error toast" }) }
  get toastSuccess() { return this.device.getByText("Item saved successfully!", { exact: true }) }
  get toastError() { return this.device.getByText("Something went wrong", { exact: true }) }

  // Snackbar
  get showSnackbarButton() { return this.device.getByRole("button", { name: "Show snackbar" }) }
  get snackbar() { return this.device.getByText("Message archived") }
  get snackbarMessage() { return this.device.getByText("Message archived", { exact: true }) }
  get snackbarDismiss() { return this.device.getByRole("button", { name: "Dismiss" }) }

  // Modal
  get showModalButton() { return this.device.getByRole("button", { name: "Show modal" }) }
  get modal() { return this.device.getByText("Modal Title") }
  get modalTitle() { return this.device.getByText("Modal Title", { exact: true }) }
  get cancelButton() { return this.device.getByRole("button", { name: "Cancel" }) }
  get confirmButton() { return this.device.getByRole("button", { name: "Confirm" }) }
}
