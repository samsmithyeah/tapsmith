import { type Device, id, text } from "pilot"

export class SpinnerScreen {
  constructor(private device: Device) {}

  get heading() { return this.device.element(text("Dropdowns")) }
  get placeholder() { return this.device.element(text("Select...")) }

  // Dropdowns
  get countryDropdown() { return this.device.element(id("country-dropdown")) }
  get colorDropdown() { return this.device.element(id("color-dropdown")) }
  get priorityDropdown() { return this.device.element(id("priority-dropdown")) }

  // Selected values
  get selectedCountry() { return this.device.element(id("selected-country")) }
  get selectedColor() { return this.device.element(id("selected-color")) }
  get selectedPriority() { return this.device.element(id("selected-priority")) }

  // Options (used during selection)
  option(label: string) { return this.device.element(text(label)) }
}
