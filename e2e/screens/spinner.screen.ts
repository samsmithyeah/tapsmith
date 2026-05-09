import { Device } from "tapsmith"

export class SpinnerScreen {
  constructor(private device: Device) {}

  get heading() { return this.device.getByText("Dropdowns", { exact: true }) }

  // Dropdowns
  get countryDropdown() { return this.device.getByDescription("Country") }
  get colorDropdown() { return this.device.getByDescription("Favorite Color") }
  get priorityDropdown() { return this.device.getByDescription("Priority") }

  // Selected values
  get selectedCountry() { return this.device.getByTestId("selected-country") }
  get selectedColor() { return this.device.getByTestId("selected-color") }
  get selectedPriority() { return this.device.getByTestId("selected-priority") }

  // Options (used during selection)
  option(label: string) { return this.device.getByText(label, { exact: true }) }
}
