/**
 * E2E tests for network route interception and mocking.
 *
 * These tests exercise the `device.route()` API against the test app's
 * API Calls screen, which fetches from jsonplaceholder.typicode.com.
 *
 * Run with --trace on to see route badges in the trace viewer:
 *   npx pilot test tests/network-mocking.test.ts --trace on
 */
import { beforeEach, describe, expect, test } from "pilot"
import { ApiCallsScreen } from "../screens/api-calls.screen.js"

describe("Network mocking", () => {
  // Network interception + real HTTP + iOS restartApp need generous timeout
  test.use({ timeout: 20_000 })

  beforeEach(async ({ device }) => {
    await device.restartApp()
    await device.getByDescription("API Calls").scrollIntoView()
    await device.getByDescription("API Calls").tap()
    const screen = new ApiCallsScreen(device)
    await expect(screen.heading).toBeVisible()
  })

  test("route.fulfill() — mock a JSON response", async ({ device }) => {
    const screen = new ApiCallsScreen(device)

    await device.route("**/posts*", async (route) => {
      await route.fulfill({
        json: [
          { id: 99, title: "Mocked Post Title", body: "This is a mocked post body" },
        ],
      })
    })

    await screen.fetchPostsButton.tap()
    await expect(screen.postsHeading).toBeVisible({ timeout: 10_000 })
    await expect(device.getByText("Mocked Post Title")).toBeVisible()

    await device.unrouteAll()
  })

  test("route.fulfill() — mock error status", async ({ device }) => {
    const screen = new ApiCallsScreen(device)

    await device.route("**/users/1", async (route) => {
      await route.fulfill({
        status: 500,
        body: "Internal Server Error",
        contentType: "text/plain",
      })
    })

    await screen.fetchUserButton.tap()
    // The app should show an error since it received a 500
    await expect(device.getByText("Failed to fetch user")).toBeVisible({ timeout: 10_000 })

    await device.unrouteAll()
  })

  test("route.abort() — block a request", async ({ device }) => {
    const screen = new ApiCallsScreen(device)

    await device.route("**/posts*", async (route) => {
      await route.abort()
    })

    await screen.fetchPostsButton.tap()
    // The app should show an error since the request was aborted
    await expect(device.getByText("Failed to fetch posts")).toBeVisible({ timeout: 10_000 })

    await device.unrouteAll()
  })

  test("route.continue() — passthrough with no modifications", async ({ device }) => {
    const screen = new ApiCallsScreen(device)

    let intercepted = false
    await device.route("**/posts*", async (route) => {
      intercepted = true
      await route.continue()
    })

    await screen.fetchPostsButton.tap()
    await expect(screen.postsHeading).toBeVisible({ timeout: 10_000 })
    expect(intercepted).toBe(true)

    await device.unrouteAll()
  })

  // TODO: route.fetch() requires two-phase interception in the plain HTTP
  // proxy path (handle_http). Currently only supported in the MITM/CONNECT
  // path. Enable once handle_http supports RouteFetch decisions.
  test.skip("route.fetch() — modify real response", async ({ device }) => {
    const screen = new ApiCallsScreen(device)

    await device.route("**/users/1", async (route) => {
      const response = await route.fetch()
      const data = response.json() as Record<string, unknown>
      data.name = "Pilot Modified User"
      await route.fulfill({ json: data })
    })

    await screen.fetchUserButton.tap()
    await expect(screen.userHeading).toBeVisible({ timeout: 10_000 })
    await expect(device.getByText("Pilot Modified User")).toBeVisible()

    await device.unrouteAll()
  })

  test("device.unroute() — remove specific route", async ({ device }) => {
    const screen = new ApiCallsScreen(device)

    const handler = async (route: import("pilot").Route) => {
      await route.fulfill({
        json: [{ id: 1, title: "Still Mocked", body: "body" }],
      })
    }

    await device.route("**/posts*", handler)

    // First call should be mocked
    await screen.fetchPostsButton.tap()
    await expect(device.getByText("Still Mocked")).toBeVisible({ timeout: 10_000 })

    // Restart to clear UI state
    await device.restartApp()
    await device.getByDescription("API Calls").scrollIntoView()
    await device.getByDescription("API Calls").tap()
    await expect(screen.heading).toBeVisible()

    // Remove the route
    await device.unroute("**/posts*", handler)

    // Second call should go through to the real server
    await screen.fetchPostsButton.tap()
    await expect(screen.postsHeading).toBeVisible({ timeout: 10_000 })
    // Real jsonplaceholder doesn't have "Still Mocked"
    await expect(device.getByText("Still Mocked")).not.toBeVisible()
  })

  test("device.unrouteAll() — remove all routes", async ({ device }) => {
    await device.route("**/posts*", async (route) => {
      await route.abort()
    })
    await device.route("**/users/*", async (route) => {
      await route.abort()
    })

    // Verify routes work
    const screen = new ApiCallsScreen(device)
    await screen.fetchPostsButton.tap()
    await expect(device.getByText("Failed to fetch posts")).toBeVisible({ timeout: 10_000 })

    // Remove all routes and restart app
    await device.unrouteAll()
    await device.restartApp()
    await device.getByDescription("API Calls").scrollIntoView()
    await device.getByDescription("API Calls").tap()
    await expect(screen.heading).toBeVisible()

    // Now requests should go through
    await screen.fetchPostsButton.tap()
    await expect(screen.postsHeading).toBeVisible({ timeout: 10_000 })
  })

  test("route with times option — limited invocations", async ({ device }) => {
    const screen = new ApiCallsScreen(device)

    await device.route("**/posts*", async (route) => {
      await route.fulfill({
        json: [{ id: 1, title: "Once Only", body: "body" }],
      })
    }, { times: 1 })

    // First call: mocked
    await screen.fetchPostsButton.tap()
    await expect(device.getByText("Once Only")).toBeVisible({ timeout: 10_000 })

    // Restart app to clear state
    await device.restartApp()
    await device.getByDescription("API Calls").scrollIntoView()
    await device.getByDescription("API Calls").tap()
    await expect(screen.heading).toBeVisible()

    // Second call: should go through (route expired after 1 use)
    await screen.fetchPostsButton.tap()
    await expect(screen.postsHeading).toBeVisible({ timeout: 10_000 })
    await expect(device.getByText("Once Only")).not.toBeVisible()
  })

  test("multiple routes — last registered wins", async ({ device }) => {
    const screen = new ApiCallsScreen(device)

    // First: broad route that would abort everything
    await device.route("**/*", async (route) => {
      await route.abort()
    })

    // Second: specific route that fulfills posts — should win for posts URLs
    await device.route("**/posts*", async (route) => {
      await route.fulfill({
        json: [{ id: 1, title: "Priority Route Won", body: "body" }],
      })
    })

    await screen.fetchPostsButton.tap()
    await expect(device.getByText("Priority Route Won")).toBeVisible({ timeout: 10_000 })

    await device.unrouteAll()
  })
})
