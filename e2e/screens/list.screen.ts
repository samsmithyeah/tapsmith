import { Device } from "tapsmith"

export class ListScreen {
  constructor(private device: Device) {}

  get itemCount() { return this.device.getByTestId("item-count") }
  get selectedCount() { return this.device.getByTestId("selected-count") }
  get allItems() { return this.device.getByText("Item ") }
  get firstItem() { return this.device.getByDescription("Item 1") }

  item(n: number) { return this.device.getByDescription(`Item ${n}`) }
  itemByText(label: string) { return this.device.getByText(label, { exact: true }) }
}
