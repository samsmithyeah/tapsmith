import { test, expect, describe, flushSoftErrors } from "pilot"
import { text, contentDesc } from "pilot"

describe("Soft assertions", () => {
  test("navigate to toggles screen for soft assertion testing", async ({ device }) => {
    await device.tap(contentDesc("Toggles"))
  })

  test("soft assertions collect failures without stopping", async ({ device }) => {
    // These should all pass — verifying soft assertions work
    await expect.soft(device.element(text("Switches"))).toBeVisible()
    await expect.soft(device.element(text("Checkboxes"))).toBeVisible()
    await expect.soft(device.element(text("Radio Buttons"))).toBeVisible()

    const errors = flushSoftErrors()
    expect(errors).toHaveLength(0)
  })
})
