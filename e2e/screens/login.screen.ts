import { type Device, role, text } from "pilot"

export class LoginScreen {
  constructor(private device: Device) {}

  get heading() { return this.device.element(text("Sign In")) }
  get emailField() { return this.device.element(role("textfield", "Email")) }
  get passwordField() { return this.device.element(role("textfield", "Password")) }
  get signInButton() { return this.device.element(role("button", "Sign in")) }
  get forgotPasswordLink() { return this.device.element(text("Forgot password?")) }
}
