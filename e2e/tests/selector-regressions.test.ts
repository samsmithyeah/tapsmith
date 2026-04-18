/**
 * Regression tests for selector and assertion bugs that have been fixed.
 * Each section preserves the original PILOT issue ID so future regressions
 * are easy to triage.
 */
import { beforeEach, describe, expect, test } from "pilot"

describe("Selector & assertion regressions", () => {
  beforeEach(async ({ device }) => {
    await device.restartApp()
  })

  // ─── PILOT-131: testId() now resolves to resource-id ───
  test("PILOT-131: testId() should find element by resource-id", async ({ device }) => {
    await device.getByDescription("Login Form").tap()
    const el = await device.getByTestId("email-input").find()
    expect(el.resourceId).toBe("email-input")
  })

  // ─── PILOT-132: hint() filters by extracted hint attribute ───
  test("PILOT-132: hint() should match by placeholder text", async ({ device }) => {
    await device.getByDescription("Login Form").tap()
    const el = await device.getByPlaceholder("Enter your email").find()
    expect(el.hint).toBe("Enter your email")
  })

  // ─── PILOT-133: type()/clearAndType() must not wrap text in literal quotes ───
  test("PILOT-133: type() should not add quotes around text", async ({ device }) => {
    await device.getByDescription("Login Form").tap()
    await device.getByTestId("email-input").type("test@example.com")
    await expect(device.getByTestId("email-input")).toHaveValue("test@example.com")
  })

  test("PILOT-133: clearAndType() should not add quotes around text", async ({ device }) => {
    await device.getByDescription("Login Form").tap()
    await device.getByTestId("email-input").type("seed text")
    await device.getByTestId("email-input").clearAndType("new@example.com")
    await expect(device.getByTestId("email-input")).toHaveValue("new@example.com")
  })

  // ─── accessibilityRole now flows through to the role attribute ───
  test("accessibilityRole should map to UIAutomator role", async ({ device }) => {
    await expect(device.getByText("Test Screens", { exact: true })).toHaveRole("heading")
  })

  // ─── toContainText now traverses descendant text nodes ───
  test("toContainText should traverse child text nodes", async ({ device }) => {
    await device.getByDescription("Dialogs").tap()
    await device.locator({ id: "show-toast-button" }).tap()
    await expect(device.locator({ id: "toast" })).toContainText("Item saved successfully!")
  })

  // ─── toBeEmpty now ignores placeholder/hint after clear() ───
  test("toBeEmpty should ignore placeholder text after clear", async ({ device }) => {
    await device.getByDescription("Login Form").tap()
    await device.getByTestId("email-input").type("hello")
    await device.getByTestId("email-input").clear()
    await expect(device.getByTestId("email-input")).toBeEmpty()
  })

  // ─── type() must round-trip shell metacharacters verbatim ───
  // Android's typeTextWithoutFocus runs `input text $tokenized` where
  // `tokenized` is passed through UiDevice.executeShellCommand with no
  // surrounding shell — so &, ;, |, $, `, (, ) etc. must survive.
  test("type() round-trips shell metacharacters", async ({ device }) => {
    await device.getByDescription("Login Form").tap()
    const tricky = "a&b;c|d$e`f(g)h"
    await device.getByTestId("email-input").type(tricky)
    await expect(device.getByTestId("email-input")).toHaveValue(tricky)
  })

  // ─── type("\n") must NOT garble surrounding characters ───
  // Before this fix, Android `input text "foo\nbar"` was tokenized on the
  // newline by the shell and only the first whitespace-delimited segment
  // reached the field — a string starting with "foo" became something
  // unpredictable. Now the agent splits printable runs on control
  // characters and dispatches Enter as a key event between them, so the
  // leading run is preserved verbatim. (What happens to characters AFTER
  // the Enter is platform-specific: Android single-line TextInput often
  // converts the Enter to a space and keeps appending; iOS UITextField
  // blurs the field and the rest is dropped. Either is acceptable; the
  // bug we're guarding against is whether the leading segment survives.)
  test("type() preserves the leading segment around a newline", async ({ device }) => {
    await device.getByDescription("Login Form").tap()
    await device.getByTestId("email-input").type("foo\nbar")
    const el = await device.getByTestId("email-input").find()
    expect(el.text ?? "").toContain("foo")
  })

  // ─── header is an accepted alias for heading on toHaveRole ───
  test("toHaveRole accepts 'header' as an alias for 'heading'", async ({ device }) => {
    await expect(device.getByText("Test Screens", { exact: true })).toHaveRole("header")
  })

  // ─── DOCUMENTED LIMITATION: typing "%s" types a literal space ───
  // Android's typeTextWithoutFocus replaces ' ' with the `input text` token
  // `%s` so spaces survive shell-arg tokenization. The reverse round-trip
  // means a literal "%s" in user text comes out as a space. iOS doesn't
  // have this issue (no shell). Locked here so a future fix can flip the
  // assertion if the limitation is removed.
  test("type() — documented %s literal limitation", async ({ device }) => {
    await device.getByDescription("Login Form").tap()
    await device.getByTestId("email-input").type("a%sb")
    const el = await device.getByTestId("email-input").find()
    // On Android the documented behavior is "a b"; on iOS the literal
    // "a%sb" survives because there's no shell-token substitution.
    expect(["a b", "a%sb"]).toContain(el.text ?? "")
  })

  // ─── getByPlaceholder negative case: unknown placeholder returns nothing ───
  test("getByPlaceholder returns no match for an unknown placeholder", async ({ device }) => {
    await device.getByDescription("Login Form").tap()
    await expect(
      device.getByPlaceholder("This placeholder definitely does not exist"),
    ).toHaveCount(0)
  })
})
