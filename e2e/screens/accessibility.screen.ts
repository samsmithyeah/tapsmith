import { Device } from "pilot"

export class AccessibilityScreen {
  constructor(private device: Device) {}

  // Roles
  get roleButton() { return this.device.locator({ id: "role-button" }) }
  get roleLink() { return this.device.locator({ id: "role-link" }) }
  get roleHeader() { return this.device.locator({ id: "role-header" }) }
  get roleImage() { return this.device.locator({ id: "role-image" }) }
  get roleAlert() { return this.device.locator({ id: "role-alert" }) }

  // Content descriptions
  get closeIcon() { return this.device.getByDescription("Close menu") }
  get cartIcon() { return this.device.getByDescription("Shopping cart with 3 items") }
  get avatar() { return this.device.locator({ id: "desc-avatar" }) }

  // Grouped elements
  get groupedProfile() { return this.device.locator({ id: "grouped-profile" }) }
}
