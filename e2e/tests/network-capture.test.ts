/**
 * E2E tests for network capture correctness (PILOT-187).
 *
 * Verifies that HTTPS requests from the app are captured with the correct
 * `https://` URL scheme — not `http://`.
 */
import { beforeEach, describe, expect, test } from "tapsmith"
import { ApiCallsScreen } from "../screens/api-calls.screen.js"

describe("Network capture", () => {
  test.use({ timeout: 20_000 })

  beforeEach(async ({ device }) => {
    await device.restartApp()
    await device.getByDescription("API Calls").scrollIntoView()
    await device.getByDescription("API Calls").tap()
    const screen = new ApiCallsScreen(device)
    await expect(screen.heading).toBeVisible()
  })

  test("HTTPS request is captured with correct scheme and properties", async ({ device }) => {
    const screen = new ApiCallsScreen(device)

    const requestPromise = device.waitForRequest(
      (req) => req.url.includes("jsonplaceholder.typicode.com/users/1"),
      { timeout: 15_000 },
    )
    const responsePromise = device.waitForResponse(
      (resp) => resp.url.includes("jsonplaceholder.typicode.com/users/1"),
      { timeout: 15_000 },
    )

    await screen.fetchUserButton.tap()

    const [request, response] = await Promise.all([requestPromise, responsePromise])

    expect(request.url).toMatch(/^https:\/\//)
    expect(request.isHttps).toBe(true)

    expect(response.url).toMatch(/^https:\/\//)
    expect(response.status).toBe(200)
  })
})
