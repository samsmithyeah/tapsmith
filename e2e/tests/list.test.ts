import { beforeAll, contentDesc, describe, expect, test, textContains } from "pilot"
import { ListScreen } from "../screens/list.screen.js"

describe("List screen", () => {
  beforeAll(async ({ device }) => {
    await device.tap(contentDesc("List"))
  })

  // ─── Element Counting ───

  test("shows item count", async ({ device }) => {
    const screen = new ListScreen(device)
    await expect(screen.itemCount).toHaveText("30 items")
  })

  test("shows initial selected count", async ({ device }) => {
    const screen = new ListScreen(device)
    await expect(screen.selectedCount).toContainText("0 selected")
  })

  // ─── Positional Selection ───

  test("first() selects the first matching element", async ({ device }) => {
    const screen = new ListScreen(device)
    const info = await screen.itemByText("Item 1").find()
    expect(info.text).toBe("Item 1")
  })

  test("nth() selects item at specific index", async ({ device }) => {
    const screen = new ListScreen(device)
    const items = await screen.allItems.all()
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

  test("tapping an item selects and deselects it", async ({ device }) => {
    const screen = new ListScreen(device)
    await screen.firstItem.tap()
    await expect(screen.selectedCount).toContainText("1 selected")

    await screen.firstItem.tap()
    await expect(screen.selectedCount).toContainText("0 selected")
  })

  // ─── all() ───

  test("all() returns array of element handles", async ({ device }) => {
    const screen = new ListScreen(device)
    const items = await screen.allItems.all()
    expect(items.length).toBeGreaterThan(0)
    const firstText = await items[0].getText()
    expect(firstText.length).toBeGreaterThan(0)
  })
})
