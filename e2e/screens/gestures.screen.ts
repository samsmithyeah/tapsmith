import { type Device, id, text } from "pilot"

export class GesturesScreen {
  constructor(private device: Device) {}

  get lastGesture() { return this.device.element(id("last-gesture")) }
  get tapCount() { return this.device.element(id("tap-count")) }
  get tapArea() { return this.device.element(id("tap-area")) }
  get longPressArea() { return this.device.element(id("long-press-area")) }
  get draggable() { return this.device.element(id("draggable")) }
  get dropZone() { return this.device.element(id("drop-zone")) }
  get pinchArea() { return this.device.element(id("pinch-area")) }
  get swipeArea() { return this.device.element(id("swipe-area")) }
  get noGestureText() { return this.device.element(text("Last gesture: None")) }
  get longPressedText() { return this.device.element(text("Long pressed!")) }
}
