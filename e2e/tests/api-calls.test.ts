/**
 * E2E tests for the API Calls screen.
 *
 * These tests make real HTTP requests to jsonplaceholder.typicode.com.
 * Run with --trace on to see network traffic in the trace viewer:
 *
 *   npx tapsmith test tests/api-calls.test.ts --trace on
 */
import { beforeEach, describe, expect, test } from "tapsmith"
import { ApiCallsScreen } from "../screens/api-calls.screen.js"
import { resetApp } from "../utils/app-reset.js"

describe("API Calls screen", () => {
  // Each test resets the app and makes real HTTP requests.
  // A full iOS restart takes ~5s, leaving little room for network latency
  // under the default 10s timeout.
  test.use({ timeout: 15_000 })

  beforeEach(async ({ device }) => {
    await resetApp(device, "/api-calls")
    const screen = new ApiCallsScreen(device)
    await expect(screen.heading).toBeVisible()
  })

  test("fetches and displays posts", async ({ device }) => {
    const screen = new ApiCallsScreen(device)
    await screen.fetchPostsButton.tap()
    await expect(screen.postsHeading).toBeVisible({ timeout: 10_000 })
  })

  test("fetches and displays user", async ({ device }) => {
    const screen = new ApiCallsScreen(device)
    await screen.fetchUserButton.tap()
    await expect(screen.userHeading).toBeVisible({ timeout: 10_000 })
  })

  test("shows error for 404 request", async ({ device }) => {
    const screen = new ApiCallsScreen(device)
    await screen.fetch404Button.tap()
    await expect(screen.errorMessage).toBeVisible({ timeout: 10_000 })
  })
})
