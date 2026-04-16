/**
 * E2E tests for the `request` fixture (PILOT-121).
 *
 * Validates that the built-in API request fixture can make HTTP calls,
 * and that it works alongside device interactions. Uses the public
 * jsonplaceholder API (same endpoint the test app hits).
 *
 * Run with --trace on to see API actions in the trace viewer:
 *
 *   npx pilot test tests/api-request-fixture.test.ts --trace on
 */
import { beforeEach, describe, expect, test } from "pilot"
import { ApiCallsScreen } from "../screens/api-calls.screen.js"

describe("request fixture", () => {
  test.use({ timeout: 15_000 })

  test("GET request returns parsed JSON", async ({ request }) => {
    const res = await request.get("https://jsonplaceholder.typicode.com/posts/1")
    expect(res.ok).toBe(true)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { id: number; title: string }
    expect(body.id).toBe(1)
    expect(typeof body.title).toBe("string")
  })

  test("POST request sends JSON data", async ({ request }) => {
    const res = await request.post("https://jsonplaceholder.typicode.com/posts", {
      data: { title: "pilot test", body: "hello from E2E", userId: 1 },
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { id: number; title: string }
    expect(body.title).toBe("pilot test")
  })

  test("non-2xx does not throw", async ({ request }) => {
    const res = await request.get("https://jsonplaceholder.typicode.com/posts/99999")
    expect(res.ok).toBe(false)
    expect(res.status).toBe(404)
  })

  test("response body is re-readable", async ({ request }) => {
    const res = await request.get("https://jsonplaceholder.typicode.com/users/1")
    const text = await res.text()
    const json = (await res.json()) as { id: number }
    expect(JSON.parse(text)).toEqual(json)
  })

  test("custom headers are sent", async ({ request }) => {
    // jsonplaceholder doesn't echo headers, but we verify the request
    // doesn't fail with custom headers attached
    const res = await request.get("https://jsonplaceholder.typicode.com/posts/1", {
      headers: { "X-Test-Header": "pilot-e2e" },
    })
    expect(res.ok).toBe(true)
  })

  describe("combined device + request", () => {
    beforeEach(async ({ device }) => {
      await device.restartApp()
      await device.getByDescription("API Calls").scrollIntoView()
      await device.getByDescription("API Calls").tap()
      const screen = new ApiCallsScreen(device)
      await expect(screen.heading).toBeVisible()
    })

    test("seed data via API then verify app can fetch same endpoint", async ({ device, request }) => {
      // Use the request fixture to verify the API is reachable
      const apiRes = await request.get("https://jsonplaceholder.typicode.com/users/1")
      expect(apiRes.ok).toBe(true)
      const user = (await apiRes.json()) as { name: string }

      // Now verify the app can also hit a similar endpoint via the UI
      const screen = new ApiCallsScreen(device)
      await screen.fetchUserButton.tap()
      await expect(screen.userHeading).toBeVisible({ timeout: 10_000 })
    })
  })
})
