import { type Device, role, text } from "pilot"

export class TogglesScreen {
  constructor(private device: Device) {}

  // Section headings
  get switchesHeading() { return this.device.element(text("Switches")) }

  // Switches
  get darkModeSwitch() { return this.device.element(role("switch", "Dark Mode")) }
  get notificationsSwitch() { return this.device.element(role("switch", "Notifications")) }

  // Checkboxes
  get agreeCheckbox() { return this.device.element(role("checkbox", "I agree to terms")) }

  // Radio buttons
  get radioSmall() { return this.device.element(role("radiobutton", "Small")) }
  get radioMedium() { return this.device.element(role("radiobutton", "Medium")) }
  get radioLarge() { return this.device.element(role("radiobutton", "Large")) }
  get smallLabel() { return this.device.element(text("Small")) }
  get mediumLabel() { return this.device.element(text("Medium")) }
  get largeLabel() { return this.device.element(text("Large")) }
}
