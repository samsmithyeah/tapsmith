import { type Device, contentDesc, id, text, textContains } from "pilot"

export class ListScreen {
  constructor(private device: Device) {}

  get itemCount() { return this.device.element(id("item-count")) }
  get selectedCount() { return this.device.element(id("selected-count")) }
  get allItems() { return this.device.element(textContains("Item ")) }
  get firstItem() { return this.device.element(contentDesc("Item 1")) }

  item(n: number) { return this.device.element(contentDesc(`Item ${n}`)) }
  itemByText(label: string) { return this.device.element(text(label)) }
}
