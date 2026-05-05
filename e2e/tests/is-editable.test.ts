import { beforeAll, describe, expect, test } from "tapsmith"

describe("isEditable", () => {
  beforeAll(async ({ device }) => {
    await device.getByDescription("Login Form").tap()
  })

  test("text field is editable", async ({ device }) => {
    const emailInput = device.getByLabel("Email")
    const editable = await emailInput.isEditable()
    expect(editable).toBe(true)
  })

  test("button is not editable", async ({ device }) => {
    const signIn = device.getByRole("button", { name: "Sign in" })
    const editable = await signIn.isEditable()
    expect(editable).toBe(false)
  })

  test("toBeEditable assertion passes for text field", async ({ device }) => {
    await expect(device.getByLabel("Email")).toBeEditable()
  })

  test("toBeEditable assertion fails for button", async ({ device }) => {
    await expect(device.getByRole("button", { name: "Sign in" })).not.toBeEditable()
  })
})
