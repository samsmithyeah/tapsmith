import { Device } from "pilot"

export class SlowLoadScreen {
  constructor(private device: Device) {}

  get heading() { return this.device.getByText("Slow Loading", { exact: true }) }
  get load2sButton() { return this.device.getByRole("button", { name: "Load data (2 seconds)" }) }
  get load5sButton() { return this.device.getByRole("button", { name: "Load data (5 seconds)" }) }
  get loadFailButton() { return this.device.getByRole("button", { name: "Load data (will fail)" }) }
  get startCounter() { return this.device.getByRole("button", { name: "Start counter" }) }

  get profileHeading() { return this.device.getByText("User Profile", { exact: true }) }
  get profileName() { return this.device.getByText("John Doe", { exact: true }) }
  get emailLabel() { return this.device.getByText("Email", { exact: true }) }
  get emailValue() { return this.device.getByText("john@example.com", { exact: true }) }
  get errorMessage() { return this.device.getByText("Network request failed: timeout", { exact: true }) }
}
