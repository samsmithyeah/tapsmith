import { Device } from "tapsmith"

export class SpinnerScreen {
  constructor(private device: Device) {}

  get heading() { return this.device.getByText("Dropdowns", { exact: true }) }

  // Dropdowns — getByTestId because the accessibilityLabel collides with
  // the static <Text> label on iOS, causing taps to hit the wrong element
  get countryDropdown() { return this.device.getByTestId("country-dropdown") }
  get colorDropdown() { return this.device.getByTestId("color-dropdown") }
  get priorityDropdown() { return this.device.getByTestId("priority-dropdown") }

  // Selected values
  get selectedCountry() { return this.device.getByTestId("selected-country") }
  get selectedColor() { return this.device.getByTestId("selected-color") }
  get selectedPriority() { return this.device.getByTestId("selected-priority") }

  // Options (used during selection)
  option(label: string) { return this.device.getByText(label, { exact: true }) }
}
