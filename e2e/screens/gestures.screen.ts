import { Device } from "pilot"

export class GesturesScreen {
  constructor(private device: Device) {}

  get lastGesture() { return this.device.locator({ id: "last-gesture" }) }
  get tapCount() { return this.device.locator({ id: "tap-count" }) }
  get tapArea() { return this.device.locator({ id: "tap-area" }) }
  get longPressArea() { return this.device.locator({ id: "long-press-area" }) }
  get draggable() { return this.device.locator({ id: "draggable" }) }
  get dropZone() { return this.device.locator({ id: "drop-zone" }) }
  get pinchArea() { return this.device.locator({ id: "pinch-area" }) }
  get swipeArea() { return this.device.locator({ id: "swipe-area" }) }
  get noGestureText() { return this.device.getByText("Last gesture: None", { exact: true }) }
}
