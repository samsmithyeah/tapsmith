/**
 * Known bugs — tests that SHOULD pass but don't due to Pilot bugs.
 * Uncomment each test as the corresponding bug is fixed.
 */
import { test, expect, describe } from "pilot"
import { text, textContains, hint, id, testId, contentDesc, role } from "pilot"

describe("Known bugs", () => {
  // ─── PILOT-131: testId() uses content-desc prefix instead of resource-id ───
  // React Native's testID maps to resource-id, but the agent looks for
  // content-desc="testid:xxx" which never matches.

  // test("PILOT-131: testId() should find element by resource-id", async ({ device }) => {
  //   await device.tap(contentDesc("Login Form"))
  //   const el = await device.element(testId("email-input")).find()
  //   expect(el.resourceId).toBe("email-input")
  // })

  // ─── PILOT-132: hint() selector matches wrong element ───
  // The hint selector falls back to By.textContains("") which matches
  // the first element on screen instead of filtering by hint attribute.

  // test("PILOT-132: hint() should match by placeholder text", async ({ device }) => {
  //   await device.tap(contentDesc("Login Form"))
  //   const el = await device.element(hint("Enter your email")).find()
  //   expect(el.className).toBe("android.widget.EditText")
  //   expect(el.hint).toBe("Enter your email")
  // })

  // ─── PILOT-133: type() wraps input text in literal double quotes ───
  // Typing "hello" results in the field containing "hello" (with quotes).

  // test("PILOT-133: type() should not add quotes around text", async ({ device }) => {
  //   await device.tap(contentDesc("Login Form"))
  //   await device.element(id("email-input")).type("test@example.com")
  //   await expect(device.element(id("email-input"))).toHaveValue("test@example.com")
  // })

  // test("PILOT-133: clearAndType() should not add quotes around text", async ({ device }) => {
  //   await device.element(id("email-input")).clearAndType("new@example.com")
  //   await expect(device.element(id("email-input"))).toHaveValue("new@example.com")
  // })

  // ─── PILOT-134: No test isolation between files ───
  // Running multiple test files in one `npx pilot test` invocation doesn't
  // reset the app between files. State from one file leaks to the next.
  // The agent is coupled to the app lifecycle so force-stop kills both.

  // test("PILOT-134: tests should be isolated between files", async ({ device }) => {
  //   // This would require running two files and verifying the second
  //   // starts from a clean state. Not testable in a single file.
  // })

  // ─── PILOT-149: .not.toBeVisible() fails immediately instead of polling ───
  // The negated assertion should poll until the element disappears or timeout,
  // but it checks once and fails immediately if the element is visible.

  // test("PILOT-149: not.toBeVisible() should poll until element disappears", async ({ device }) => {
  //   await device.tap(contentDesc("Dialogs"))
  //   await device.tap(id("show-toast-button"))
  //   // Toast auto-hides after 3 seconds
  //   await expect(device.element(id("toast"))).toBeVisible()
  //   await expect(device.element(id("toast"))).not.toBeVisible({ timeout: 10000 })
  // })

  // ─── PILOT-135: No scrollUntilVisible action ───
  // Tapping off-screen elements requires manual swipe() first.
  // A scrollUntilVisible method would handle this automatically.

  // test("PILOT-135: tap() should auto-scroll to off-screen elements", async ({ device }) => {
  //   // "Scroll" card is below the fold on home screen
  //   await device.tap(contentDesc("Scroll"))
  //   await expect(device.element(text("Scroll Testing"))).toBeVisible()
  // })

  // ─── RN accessibilityRole not mapped to Android UIAutomator role ───
  // React Native's accessibilityRole="header" etc. don't surface as
  // the `role` attribute in the UIAutomator hierarchy on Android.

  // test("accessibilityRole should map to UIAutomator role", async ({ device }) => {
  //   await expect(device.element(text("Test Screens"))).toHaveRole("header")
  // })

  // ─── toContainText/toHaveText returns empty for parent elements ───
  // When testID is on a parent View, toContainText returns "" because
  // the parent's text attribute is empty — the text is in child nodes.

  // test("toContainText should traverse child text nodes", async ({ device }) => {
  //   await device.tap(contentDesc("Dialogs"))
  //   await device.tap(id("show-toast-button"))
  //   await expect(device.element(id("toast"))).toContainText("Item saved successfully!")
  // })

  // ─── toBeEmpty reports placeholder as text after clear() ───
  // After clearing a TextInput, UIAutomator reports the placeholder/hint
  // as the element's text, so toBeEmpty() fails.

  // test("toBeEmpty should ignore placeholder text after clear", async ({ device }) => {
  //   await device.tap(contentDesc("Login Form"))
  //   await device.element(id("email-input")).type("hello")
  //   await device.element(id("email-input")).clear()
  //   await expect(device.element(id("email-input"))).toBeEmpty()
  // })

  test("placeholder — all known bugs are commented out above", async () => {
    // This test exists so the file isn't empty.
    // Remove it once any of the above tests are uncommented.
    expect(true).toBe(true)
  })
})
