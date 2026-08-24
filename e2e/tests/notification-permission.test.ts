import { test, expect, describe } from "tapsmith"

// PILOT-291 regression coverage. The root config sets
// `permissions: { notifications: "granted" }`, so by the time any test runs:
//   - Android: POST_NOTIFICATIONS was pre-granted at session setup (pm grant,
//     no dialog ever appears).
//   - iOS: a conflicting recorded state was reset at setup, and the agent's
//     interruption monitor auto-accepts the one-shot prompt when the app
//     requests authorization.
//
// This file fails whenever the permissions config does not survive the trip
// into whichever process actually starts the session (sequential CLI,
// parallel worker, UI/watch mode) — the class of integration gap that code
// review kept finding in PR #198. The denied-state counterpart lives in
// notification-permission-denied.test.ts under its own project.

describe("Notification permission (config: granted)", () => {
  test("the app is granted notification permission", async ({ device }) => {
    await device.openDeepLink("tapsmithtest:///permissions")
    await expect(device.getByText("Permissions", { exact: true }).first()).toBeVisible()

    await device.locator({ id: "request-notifications" }).tap()

    // iOS: the request may briefly show the system prompt before the agent's
    // interruption monitor answers it — but monitors only fire on the next
    // XCUITest interaction, so poll with a real tap (Check) rather than a
    // read-only assertion. Android: the permission is already granted, the
    // request resolves immediately, and the first poll iteration settles it.
    await expect
      .poll(
        async () => {
          await device.locator({ id: "check-notifications" }).tap()
          return device.locator({ id: "notifications-status" }).getText()
        },
        { timeout: 20_000 },
      )
      .toBe("granted")
  })
})
