import { Device } from "pilot"

export class ScrollScreen {
  constructor(private device: Device) {}

  get heading() { return this.device.getByText("Scroll Testing", { exact: true }) }
  get sectionA() { return this.device.locator({ id: "section-Section A" }) }
  get firstItem() { return this.device.locator({ id: "scroll-item-A-1" }) }
}
