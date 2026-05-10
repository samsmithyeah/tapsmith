import { Device } from "tapsmith"

export class VisibilityScreen {
  constructor(private device: Device) {}

  // Banner
  get banner() { return this.device.getByText("Welcome! This is a dismissable banner.") }
  get dismissBannerButton() { return this.device.getByRole("button", { name: "Dismiss banner" }) }
  get showBannerButton() { return this.device.getByRole("button", { name: "Show banner" }) }

  // Expandable section
  get expandToggle() { return this.device.getByRole("button", { name: "Toggle details" }) }
  get expandedContent() { return this.device.getByText("This content is hidden by default") }

  // Dynamic list
  get addItemButton() { return this.device.getByRole("button", { name: "Add item" }) }
  get deleteButton() { return this.device.getByText("Delete") }
  itemCount(n: number) { return this.device.getByText(`${n} items`, { exact: true }) }

  // Loading state
  get startLoadingButton() { return this.device.getByRole("button", { name: "Start loading" }) }
  get loadingIndicator() { return this.device.getByText("Loading...", { exact: true }) }
  get contentLoaded() { return this.device.getByText("Content loaded", { exact: true }) }

  // Error state
  get toggleErrorButton() { return this.device.getByRole("button", { name: "Toggle error" }) }
  get errorMessage() { return this.device.getByText("An error occurred. Please try again.") }
  get errorText() { return this.device.getByText("An error occurred. Please try again.", { exact: true }) }
}
