import { beforeAll, describe, expect, flushSoftErrors, test } from "pilot"

describe("Soft assertions", () => {
  beforeAll(async ({ device }) => {
    await device.getByDescription("Toggles").tap()
  })

  test("soft assertions collect failures without stopping", async ({ device }) => {
    // These should all pass — verifying soft assertions work
    await expect.soft(device.getByText("Switches", { exact: true })).toBeVisible()
    await expect.soft(device.getByText("Checkboxes", { exact: true })).toBeVisible()
    await expect.soft(device.getByText("Radio Buttons", { exact: true })).toBeVisible()

    const errors = flushSoftErrors()
    expect(errors).toHaveLength(0)
  })
})
