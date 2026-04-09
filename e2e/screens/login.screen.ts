import { Device } from "pilot"

export class LoginScreen {
  constructor(private device: Device) {}

  get heading() { return this.device.getByText("Sign In", { exact: true }) }
  get emailField() { return this.device.getByRole("textfield", { name: "Email" }) }
  get passwordField() { return this.device.getByRole("textfield", { name: "Password" }) }
  get signInButton() { return this.device.getByRole("button", { name: "Sign in" }) }
  get forgotPasswordLink() { return this.device.getByText("Forgot password?", { exact: true }) }
}
