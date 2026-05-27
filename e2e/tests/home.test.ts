import { describe, expect, test } from "../fixtures.js"

describe("Home screen", () => {
  test("shows the app header", async ({ homeScreen }) => {
    await expect(homeScreen.header).toBeVisible()
  })

  test("displays navigation cards", async ({ homeScreen }) => {
    await expect(homeScreen.loginCard).toBeVisible()
    await expect(homeScreen.listCard).toBeVisible()
    await expect(homeScreen.togglesCard).toBeVisible()
    await expect(homeScreen.spinnerCard).toBeVisible()
    await expect(homeScreen.gesturesCard).toBeVisible()
    await expect(homeScreen.dialogsCard).toBeVisible()
  })

  test("cards have accessible labels", async ({ homeScreen }) => {
    await expect(homeScreen.loginCard).toHaveText("Login Form")
    await expect(homeScreen.listCard).toHaveText("List")
  })

  test("header element exists and has text", async ({ homeScreen }) => {
    await expect(homeScreen.header).toExist()
    await expect(homeScreen.header).toHaveText("Test Screens")
  })

  test("can scroll to see more cards", async ({ homeScreen }) => {
    await homeScreen.scrollCard.scrollIntoView()
    await expect(homeScreen.slowLoadCard).toBeVisible()
    await expect(homeScreen.scrollCard).toBeVisible()
  })
})
