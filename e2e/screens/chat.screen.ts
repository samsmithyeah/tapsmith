import { Device } from "tapsmith"

/**
 * The Chat screen: two app instances talk through an HTTP server the test
 * hosts (see tests/multi-device/). Each device gets its own instance.
 */
export class ChatScreen {
  constructor(private device: Device) {}

  get heading() { return this.device.getByText("Chat", { exact: true }).first() }
  get serverField() { return this.device.getByRole("textfield", { name: "Server" }) }
  get nameField() { return this.device.getByRole("textfield", { name: "Name" }) }
  get joinButton() { return this.device.getByRole("button", { name: "Join" }) }
  get messageField() { return this.device.getByRole("textfield", { name: "Message" }) }
  get sendButton() { return this.device.getByRole("button", { name: "Send" }) }
  get error() { return this.device.getByTestId("chat-error") }

  /** The rendered `<name>: <text>` line for one message. */
  message(name: string, text: string) {
    return this.device.getByText(`${name}: ${text}`, { exact: true })
  }

  async join(name: string) {
    await this.nameField.type(name)
    await this.joinButton.tap()
    await this.device.getByText(`Chatting as ${name}`, { exact: true }).waitFor()
  }

  async send(text: string) {
    await this.messageField.type(text)
    // Submit from the keyboard rather than tapping Send: on iOS the software
    // keyboard covers the button, and a tap on a covered element reports
    // success without ever reaching it (the message is never posted).
    await this.device.pressKey("enter")
  }
}
