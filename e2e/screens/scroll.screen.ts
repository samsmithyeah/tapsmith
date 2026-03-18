import { type Device, id, text } from "pilot"

export class ScrollScreen {
  constructor(private device: Device) {}

  get heading() { return this.device.element(text("Scroll Testing")) }
  get sectionA() { return this.device.element(id("section-Section A")) }
  get firstItem() { return this.device.element(id("scroll-item-A-1")) }
}
