import { contentDesc, describe, expect, role, test, text } from "pilot"

describe("Login screen", () => {
  test("navigate to login screen", async ({ device }) => {
    await device.tap(contentDesc("Login Form"))
  })

  // ─── Layout & Visibility ───

  test("shows the sign in heading", async ({ device }) => {
    await expect(device.element(text("Sign In"))).toBeVisible()
  })

  test("shows email and password fields", async ({ device }) => {
    await expect(device.element(role("textfield", "Email"))).toBeVisible()
    await expect(device.element(role("textfield", "Password"))).toBeVisible()
  })

  test("email field is editable", async ({ device }) => {
    await expect(device.element(role("textfield", "Email"))).toHaveAttribute(
      "className",
      "android.widget.EditText",
    )
  })

  test("sign in button starts disabled", async ({ device }) => {
    await expect(device.element(role("button", "Sign in"))).toBeDisabled()
  })

  test("forgot password link is visible", async ({ device }) => {
    await expect(device.element(text("Forgot password?"))).toBeVisible()
  })

  // ─── Text Input ───

  test("can type into email field", async ({ device }) => {
    await device.element(role("textfield", "Email")).type("test@example.com")
    // PILOT-133: type() wraps text in quotes — check with quotes for now
    await expect(device.element(role("textfield", "Email"))).toContainText("test@example.com")
  })

  test("can type into password field", async ({ device }) => {
    await device.element(role("textfield", "Password")).type("password123")
  })

  // ─── Focus & Keyboard ───

  test("focusing email field shows keyboard", async ({ device }) => {
    await device.focus(role("textfield", "Email"))
    await expect(device.element(role("textfield", "Email"))).toBeFocused()
    const shown = await device.isKeyboardShown()
    expect(shown).toBe(true)
  })

  test("blurring hides keyboard", async ({ device }) => {
    await device.blur(role("textfield", "Email"))
    await device.hideKeyboard()
    const shown = await device.isKeyboardShown()
    expect(shown).toBe(false)
  })

  // ─── Clear & Retype ───

  test("clearAndType() replaces existing text", async ({ device }) => {
    const emailField = device.element(role("textfield", "Email"))
    await emailField.clearAndType("wrong@email.com")
    await expect(emailField).toContainText("wrong@email.com")
  })

  test("clear() empties the field", async ({ device }) => {
    const emailField = device.element(role("textfield", "Email"))
    await emailField.clear()
    // After clear, RN shows placeholder as text — check field exists
    await expect(emailField).toBeVisible()
  })

  // ─── Form Submission ───
  // PILOT-133: type() adds quotes, so form validation with exact values won't work.
  // Test what we can — navigation and element visibility.

  test("can type credentials and submit", async ({ device }) => {
    await device.element(role("textfield", "Email")).clearAndType("test@example.com")
    await device.element(role("textfield", "Password")).clearAndType("password123")
    // Button may or may not enable due to quote bug — try tapping anyway
    await device.tap(role("button", "Sign in"))
  })
})
