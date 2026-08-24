import { test, expect, describe } from "tapsmith"

// PILOT-291 regression coverage, denied state. This file is matched only by
// the `notifications-denied` project, whose `use` block overrides the root
// config with `permissions: { notifications: "denied" }`. Because the rest
// of the suite runs with "granted", starting this project's session forces
// the full conflict path:
//   - Android: pm revoke + the user-fixed "don't ask again" flag, so the
//     request below resolves to denied with no system dialog.
//   - iOS: the recorded granted state conflicts with the target, so setup
//     uninstalls/reinstalls the app back to notDetermined, and the agent's
//     interruption monitor then declines the one-shot prompt.
// It also exercises the per-project device-signature switch: same device,
// different permission policy, so the session must be re-established rather
// than reused as-is.

describe("Notification permission (config: denied)", () => {
  test("the app is denied notification permission", async ({ device }) => {
    await device.openDeepLink("tapsmithtest:///permissions")
    await expect(device.getByText("Permissions", { exact: true }).first()).toBeVisible()

    await device.locator({ id: "request-notifications" }).tap()

    // Poll with a real tap so the iOS interruption monitor (which only fires
    // on interactions) gets a chance to decline the prompt; see the granted
    // test for the full rationale.
    await expect
      .poll(
        async () => {
          await device.locator({ id: "check-notifications" }).tap()
          return device.locator({ id: "notifications-status" }).getText()
        },
        { timeout: 20_000 },
      )
      .toBe("denied")
  })
})
