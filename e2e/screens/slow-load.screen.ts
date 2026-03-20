import { type Device, role, text } from "pilot"

export class SlowLoadScreen {
  constructor(private device: Device) {}

  get heading() { return this.device.element(text("Slow Loading")) }
  get load2sButton() { return this.device.element(role("button", "Load data (2 seconds)")) }
  get load5sButton() { return this.device.element(role("button", "Load data (5 seconds)")) }
  get loadFailButton() { return this.device.element(role("button", "Load data (will fail)")) }
  get startCounter() { return this.device.element(role("button", "Start counter")) }

  get profileHeading() { return this.device.element(text("User Profile")) }
  get profileName() { return this.device.element(text("John Doe")) }
  get emailLabel() { return this.device.element(text("Email")) }
  get emailValue() { return this.device.element(text("john@example.com")) }
  get errorMessage() { return this.device.element(text("Network request failed: timeout")) }
}
