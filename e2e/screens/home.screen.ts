import { type Device, text } from "pilot"

export class HomeScreen {
  constructor(private device: Device) {}

  get header() { return this.device.element(text("Test Screens")) }

  // Navigation cards
  get loginCard() { return this.device.element(text("Login Form")) }
  get listCard() { return this.device.element(text("List")) }
  get togglesCard() { return this.device.element(text("Toggles")) }
  get spinnerCard() { return this.device.element(text("Spinner")) }
  get gesturesCard() { return this.device.element(text("Gestures")) }
  get dialogsCard() { return this.device.element(text("Dialogs")) }
  get slowLoadCard() { return this.device.element(text("Slow Load")) }
  get scrollCard() { return this.device.element(text("Scroll")) }

  // Card descriptions
  get loginDescription() { return this.device.element(text("Text inputs, buttons, focus/blur, keyboard")) }
  get listDescription() { return this.device.element(text("Scrollable list, filtering, counting items")) }
}
