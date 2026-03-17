import { contentDesc, describe, expect, id, test, text, textContains } from "pilot"

describe("List screen", () => {
  test("navigate to list screen", async ({ device }) => {
    await device.tap(contentDesc("List"))
  })

  // ─── Element Counting ───

  test("shows item count", async ({ device }) => {
    await expect(device.element(id("item-count"))).toHaveText("30 items")
  })

  test("shows initial selected count", async ({ device }) => {
    await expect(device.element(id("selected-count"))).toContainText("0 selected")
  })

  // ─── Positional Selection ───

  test("first() selects the first matching element", async ({ device }) => {
    const firstItem = device.element(text("Item 1"))
    const info = await firstItem.find()
    expect(info.text).toBe("Item 1")
  })

  test("nth() selects item at specific index", async ({ device }) => {
    const items = await device.element(textContains("Item ")).all()
    expect(items.length).toBeGreaterThan(1)
    const secondText = await items[1].getText()
    expect(secondText.length).toBeGreaterThan(0)
  })

  // ─── Filter ───

  test("filter({ hasNotText }) excludes matches", async ({ device }) => {
    const nonPremium = device.element(textContains("Item")).filter({ hasNotText: "Premium" })
    const count = await nonPremium.count()
    expect(count).toBeGreaterThan(0)
  })

  // ─── Selection ───

  test("tapping item by accessibilityLabel selects it", async ({ device }) => {
    await device.tap(contentDesc("Item 1"))
    await expect(device.element(id("selected-count"))).toContainText("1 selected")
  })

  test("tapping again deselects it", async ({ device }) => {
    await device.tap(contentDesc("Item 1"))
    await expect(device.element(id("selected-count"))).toContainText("0 selected")
  })

  // ─── all() ───

  test("all() returns array of element handles", async ({ device }) => {
    const items = await device.element(textContains("Item ")).all()
    expect(items.length).toBeGreaterThan(0)
    const firstText = await items[0].getText()
    expect(firstText.length).toBeGreaterThan(0)
  })
})
