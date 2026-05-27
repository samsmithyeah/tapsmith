/**
 * E2E tests for network capture correctness (PILOT-187).
 *
 * Verifies that HTTPS requests from the app are captured with the correct
 * `https://` URL scheme — not `http://`.
 */
import { describe, expect, test } from "../fixtures.js"
import { resetApp } from "../utils/app-reset.js"

describe("Network capture", () => {
  test.use({ timeout: 20_000 })

  test.beforeEach(async ({ device, apiCallsScreen }) => {
    await resetApp(device, "/api-calls")
    await expect(apiCallsScreen.heading).toBeVisible()
  })

  test("HTTPS request is captured with correct scheme and properties", async ({ device, apiCallsScreen }) => {
    await device.route("**/users/1", async (route) => {
      await route.fulfill({
        json: { id: 1, name: "Tapsmith Capture User" },
      })
    })

    try {
      const requestPromise = device.waitForRequest(
        (req) => req.url.includes("jsonplaceholder.typicode.com/users/1"),
        { timeout: 15_000 },
      )
      const responsePromise = device.waitForResponse(
        (resp) => resp.url.includes("jsonplaceholder.typicode.com/users/1"),
        { timeout: 15_000 },
      )

      await apiCallsScreen.fetchUserButton.tap()

      const [request, response] = await Promise.all([requestPromise, responsePromise])

      expect(request.url).toMatch(/^https:\/\//)
      expect(request.isHttps).toBe(true)

      expect(response.url).toMatch(/^https:\/\//)
      expect(response.status).toBe(200)
    } finally {
      await device.unrouteAll()
    }
  })
})
