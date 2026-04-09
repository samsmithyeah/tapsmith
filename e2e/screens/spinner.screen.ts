import { Device } from "pilot"

export class SpinnerScreen {
  constructor(private device: Device) {}

  get heading() { return this.device.getByText("Dropdowns", { exact: true }) }

  // Dropdowns
  get countryDropdown() { return this.device.locator({ id: "country-dropdown" }) }
  get colorDropdown() { return this.device.locator({ id: "color-dropdown" }) }
  get priorityDropdown() { return this.device.locator({ id: "priority-dropdown" }) }

  // Selected values
  get selectedCountry() { return this.device.locator({ id: "selected-country" }) }
  get selectedColor() { return this.device.locator({ id: "selected-color" }) }
  get selectedPriority() { return this.device.locator({ id: "selected-priority" }) }

  // Options (used during selection)
  option(label: string) { return this.device.getByText(label, { exact: true }) }
}
