/**
 * iOS counterpart to `network-passthrough-defaults.android.test.ts` (PILOT-279).
 *
 * On iOS the built-in passthrough default for `firestore.googleapis.com` still
 * applies: the platform's Firestore gRPC stack compiles its CA roots into the
 * app binary, so MITM'ing that host would break the app under test rather than
 * capture it. This pins that the default was narrowed to Android only, and not
 * removed outright.
 *
 * Note what this asserts and what it does not. It proves the *host rule* is
 * active on iOS — the connection is tunnelled, so interception sees nothing.
 * It does not prove anything about gRPC: the request here comes from React
 * Native's fetch, which would otherwise be perfectly capturable, and that is
 * precisely why it is a good probe for the rule itself.
 */
import { describe, expect, test } from "../fixtures.js"
import { resetApp } from "../utils/app-reset.js"

const FIRESTORE_HOST = "firestore.googleapis.com"

describe("Embedded-root passthrough defaults (iOS)", () => {
  test.use({ timeout: 30_000 })

  test.beforeEach(async ({ device, apiCallsScreen }) => {
    await resetApp(device, "/api-calls")
    await expect(apiCallsScreen.heading).toBeVisible()
  })

  test("a built-in passthrough host stays tunnelled on iOS", async ({
    device,
    apiCallsScreen,
  }) => {
    const firestoreRequest = device.waitForRequest((req) => req.url.includes(FIRESTORE_HOST), {
      timeout: 10_000,
    })
    // Control: an ordinary host on the same screen must still be captured, so a
    // failure here reads as "capture is broken" rather than "the rule works".
    const controlRequest = device.waitForRequest(
      (req) => req.url.includes("jsonplaceholder.typicode.com"),
      { timeout: 20_000 },
    )

    await apiCallsScreen.fetchFirestoreHostButton.tap()

    let capturedFirestoreUrl: string | null = null
    try {
      capturedFirestoreUrl = (await firestoreRequest).url
    } catch {
      // Expected: the tunnelled connection produces no request event.
    }
    expect(capturedFirestoreUrl).toBe(null)

    await apiCallsScreen.fetchUserButton.tap()
    const control = await controlRequest
    expect(control.url).toContain("jsonplaceholder.typicode.com")
  })
})
