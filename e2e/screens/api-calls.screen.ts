import { Device } from "pilot"

export class ApiCallsScreen {
  constructor(private device: Device) {}

  get heading() { return this.device.getByText("API Calls", { exact: true }) }
  get fetchPostsButton() { return this.device.getByRole("button", { name: "Fetch Posts" }) }
  get fetchUserButton() { return this.device.getByRole("button", { name: "Fetch User" }) }
  get fetch404Button() { return this.device.getByRole("button", { name: "Fetch 404" }) }
  get postsHeading() { return this.device.getByText("Posts", { exact: true }) }
  get userHeading() { return this.device.getByText("User", { exact: true }) }
  get errorMessage() { return this.device.getByText("Request failed") }
}
