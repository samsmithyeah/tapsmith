import { Device } from "tapsmith"

export class ScrollScreen {
  constructor(private device: Device) {}

  get heading() { return this.device.getByText("Scroll Testing", { exact: true }) }
  get sectionA() { return this.device.getByRole("header", { name: "Section A" }) }
  get firstItem() { return this.device.getByDescription("Item A-1") }
}
