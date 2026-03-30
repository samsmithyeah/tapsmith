import { type Device, role, text, textContains } from "pilot"

export class ApiCallsScreen {
  constructor(private device: Device) {}

  get heading() { return this.device.element(text("API Calls")) }
  get fetchPostsButton() { return this.device.element(role("button", "Fetch Posts")) }
  get fetchUserButton() { return this.device.element(role("button", "Fetch User")) }
  get fetch404Button() { return this.device.element(role("button", "Fetch 404")) }
  get postsHeading() { return this.device.element(text("Posts")) }
  get userHeading() { return this.device.element(text("User")) }
  get errorMessage() { return this.device.element(textContains("Request failed")) }
}
