import { type Device, contentDesc, id } from "pilot"

export class AccessibilityScreen {
  constructor(private device: Device) {}

  // Roles
  get roleButton() { return this.device.element(id("role-button")) }
  get roleLink() { return this.device.element(id("role-link")) }
  get roleHeader() { return this.device.element(id("role-header")) }
  get roleImage() { return this.device.element(id("role-image")) }
  get roleAlert() { return this.device.element(id("role-alert")) }

  // Content descriptions
  get closeIcon() { return this.device.element(contentDesc("Close menu")) }
  get cartIcon() { return this.device.element(contentDesc("Shopping cart with 3 items")) }
  get avatar() { return this.device.element(id("desc-avatar")) }

  // Grouped elements
  get groupedProfile() { return this.device.element(id("grouped-profile")) }
}
