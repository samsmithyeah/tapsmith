import { Device } from "tapsmith"

export class AnimatingScreen {
  constructor(private device: Device) {}

  get heading() { return this.device.getByText("Creating your story", { exact: true }) }
  get status() { return this.device.getByText("Generating illustration", { exact: true }) }
  get stoppedStatus() { return this.device.getByText("Stopped", { exact: true }) }
  get stopButton() { return this.device.getByRole("button", { name: "Stop generation" }) }
  get backButton() { return this.device.getByRole("button", { name: "Go back" }) }
}
