import { type Device, id, text, textContains } from "pilot"

export class VisibilityScreen {
  constructor(private device: Device) {}

  // Banner
  get banner() { return this.device.element(id("banner")) }
  get dismissBannerButton() { return this.device.element(id("dismiss-banner")) }
  get showBannerButton() { return this.device.element(id("show-banner")) }

  // Expandable section
  get expandToggle() { return this.device.element(id("expand-toggle")) }
  get expandedContent() { return this.device.element(id("expanded-content")) }

  // Dynamic list
  get addItemButton() { return this.device.element(id("add-item")) }
  get deleteButton() { return this.device.element(textContains("Delete")) }
  itemCount(n: number) { return this.device.element(text(`${n} items`)) }

  // Loading state
  get startLoadingButton() { return this.device.element(id("start-loading")) }
  get loadingIndicator() { return this.device.element(text("Loading...")) }
  get contentLoaded() { return this.device.element(text("Content loaded")) }

  // Error state
  get toggleErrorButton() { return this.device.element(id("toggle-error")) }
  get errorMessage() { return this.device.element(id("error-message")) }
  get errorText() { return this.device.element(text("An error occurred. Please try again.")) }
}
