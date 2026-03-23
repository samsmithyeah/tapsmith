/**
 * E2E tests for the API Calls screen.
 *
 * These tests make real HTTP requests to jsonplaceholder.typicode.com.
 * Run with --trace on to see network traffic in the trace viewer:
 *
 *   npx pilot test tests/api-calls.test.ts --trace on
 */
import { beforeEach, contentDesc, describe, expect, test } from "pilot"
import { ApiCallsScreen } from "../screens/api-calls.screen.js"

describe("API Calls screen", () => {
  beforeEach(async ({ device }) => {
    await device.restartApp()
    await device.swipe("up")
    await device.tap(contentDesc("API Calls"))
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
