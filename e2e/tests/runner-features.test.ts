import { describe, expect, test } from "../fixtures.js"

// ─── test.use() ───
//
// These tests verify that test.use({ timeout }) changes the assertion
// auto-wait timeout. All tests use positive assertions only (no try/catch)
// so traces show clean results.

describe("test.use() timeout override", () => {
  test.beforeAll(async ({ device }) => {
    await device.openDeepLink("tapsmithtest:///slow-load")
  })

  describe("overridden timeout finds slow element", () => {
    // 8s timeout is enough for the 5s element
    test.use({ timeout: 8000 })

    test("5s element appears within overridden 8s timeout", async ({ slowLoadScreen }) => {
      await slowLoadScreen.load5sButton.tap()
      await expect(slowLoadScreen.profileHeading).toBeVisible()
    })
  })

  describe("shorter override still works for fast element", () => {
    // 3s timeout is enough for the 2s element
    test.use({ timeout: 3000 })

    test("2s element appears within overridden 3s timeout", async ({ slowLoadScreen }) => {
      await slowLoadScreen.load2sButton.tap()
      await expect(slowLoadScreen.profileHeading).toBeVisible()
    })
  })

  describe("nested cascading", () => {
    // Outer scope: 2s timeout — too short for the 5s element
    test.use({ timeout: 2000 })

    describe("inner override", () => {
      // Inner scope: 8s timeout — long enough for the 5s element.
      // If cascading didn't work and the outer 2s applied, this would fail.
      test.use({ timeout: 8000 })

      test("inner 8s timeout overrides outer 2s for 5s element", async ({ slowLoadScreen }) => {
        await slowLoadScreen.load5sButton.tap()
        await expect(slowLoadScreen.profileHeading).toBeVisible()
      })
    })
  })
})
