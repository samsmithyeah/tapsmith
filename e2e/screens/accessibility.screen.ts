import { Device } from "tapsmith"

export class AccessibilityScreen {
  constructor(private device: Device) {}

  // Navigation
  get heading() { return this.device.getByText("Accessibility Testing", { exact: true }) }
  get navCard() { return this.device.getByDescription("Accessibility") }

  // Roles — accessibilityLabel is used instead of getByRole because RN
  // accessibilityRole does not map to Android's role attribute (PILOT-XXX)
  get roleButton() { return this.device.getByDescription("Submit form") }
  get roleLink() { return this.device.getByDescription("Visit website") }
  get roleHeader() { return this.device.getByDescription("Section header") }
  get roleImage() { return this.device.getByDescription("Profile photo") }
  get roleAlert() { return this.device.getByDescription("Warning message") }

  // Content descriptions
  get closeIcon() { return this.device.getByDescription("Close menu") }
  get cartIcon() { return this.device.getByDescription("Shopping cart with 3 items") }
  get avatar() { return this.device.getByDescription("User avatar") }

  // Grouped elements
  get groupedProfile() { return this.device.getByDescription("John Doe, Software Engineer, Online") }
}
