import { Device } from "pilot"

export class VisibilityScreen {
  constructor(private device: Device) {}

  // Banner
  get banner() { return this.device.locator({ id: "banner" }) }
  get dismissBannerButton() { return this.device.locator({ id: "dismiss-banner" }) }
  get showBannerButton() { return this.device.locator({ id: "show-banner" }) }

  // Expandable section
  get expandToggle() { return this.device.locator({ id: "expand-toggle" }) }
  get expandedContent() { return this.device.locator({ id: "expanded-content" }) }

  // Dynamic list
  get addItemButton() { return this.device.locator({ id: "add-item" }) }
  get deleteButton() { return this.device.getByText("Delete") }
  itemCount(n: number) { return this.device.getByText(`${n} items`, { exact: true }) }

  // Loading state
  get startLoadingButton() { return this.device.locator({ id: "start-loading" }) }
  get loadingIndicator() { return this.device.getByText("Loading...", { exact: true }) }
  get contentLoaded() { return this.device.getByText("Content loaded", { exact: true }) }

  // Error state
  get toggleErrorButton() { return this.device.locator({ id: "toggle-error" }) }
  get errorMessage() { return this.device.locator({ id: "error-message" }) }
  get errorText() { return this.device.getByText("An error occurred. Please try again.", { exact: true }) }
}
