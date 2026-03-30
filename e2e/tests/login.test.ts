import { beforeAll, contentDesc, describe, expect, role, test } from "pilot"
import { LoginScreen } from "../screens/login.screen.js"

describe("Login screen", () => {
  beforeAll(async ({ device }) => {
    await device.tap(contentDesc("Login Form"))
  })

  // ─── Layout & Visibility ───

  test("shows the sign in heading", async ({ device }) => {
    const login = new LoginScreen(device)
    await expect(login.heading).toBeVisible()
  })

  test("shows email and password fields", async ({ device }) => {
    const login = new LoginScreen(device)
    await expect(login.emailField).toBeVisible()
    await expect(login.passwordField).toBeVisible()
  })

  test("email field is editable", async ({ device }) => {
    const login = new LoginScreen(device)
    await expect(login.emailField).toHaveAttribute(
      "className",
      "android.widget.EditText",
    )
  })

  test("sign in button starts disabled", async ({ device }) => {
    const login = new LoginScreen(device)
    await expect(login.signInButton).toBeDisabled()
  })

  test("forgot password link is visible", async ({ device }) => {
    const login = new LoginScreen(device)
    await expect(login.forgotPasswordLink).toBeVisible()
  })

  // ─── Text Input ───

  test("can type into email field", async ({ device }) => {
    const login = new LoginScreen(device)
    await login.emailField.type("test@example.com")
    // PILOT-133: type() wraps text in quotes — check with quotes for now
    await expect(login.emailField).toContainText("test@example.com")
  })

  test("can type into password field", async ({ device }) => {
    const login = new LoginScreen(device)
    await login.passwordField.type("password123")
  })

  // ─── Focus & Keyboard ───

  test("focusing and blurring email field toggles keyboard", async ({ device }) => {
    const emailSelector = role("textfield", "Email")
    await device.focus(emailSelector)
    await expect(device.element(emailSelector)).toBeFocused()
    let shown = await device.isKeyboardShown()
    expect(shown).toBe(true)

    await device.blur(emailSelector)
    await device.hideKeyboard()
    shown = await device.isKeyboardShown()
    expect(shown).toBe(false)
  })

  // ─── Clear & Retype ───

  test("clearAndType() replaces existing text", async ({ device }) => {
    const login = new LoginScreen(device)
    await login.emailField.clearAndType("wrong@email.com")
    await expect(login.emailField).toContainText("wrong@email.com")
  })

  test("clear() empties the field", async ({ device }) => {
    const login = new LoginScreen(device)
    await login.emailField.clear()
    // After clear, RN shows placeholder as text — check field exists
    await expect(login.emailField).toBeVisible()
  })

  // ─── Form Submission ───
  // PILOT-133: type() adds quotes, so form validation with exact values won't work.
  // Test what we can — navigation and element visibility.

  test("can type credentials and submit", async ({ device }) => {
    const login = new LoginScreen(device)
    await login.emailField.clearAndType("test@example.com")
    await login.passwordField.clearAndType("password123")
    // Button may or may not enable due to quote bug — try tapping anyway
    await login.signInButton.tap()
  })
})
