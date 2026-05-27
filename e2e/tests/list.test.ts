import { describe, expect, test } from "../fixtures.js";

describe("List screen", () => {
  test.beforeAll(async ({ device }) => {
    await device.openDeepLink("tapsmithtest:///list");
  });

  // ─── Element Counting ───

  test("shows item count", async ({ listScreen }) => {
    await expect(listScreen.itemCount).toHaveText("30 items");
  });

  test("shows initial selected count", async ({ listScreen }) => {
    await expect(listScreen.selectedCount).toContainText("0 selected");
  });

  // ─── Positional Selection ───

  test("first() selects the first matching element", async ({ listScreen }) => {
    const info = listScreen.allItems.first();
    await expect(info).toHaveText("Item 1");
  });

  test("nth() selects item at specific index", async ({ listScreen }) => {
    const items = await listScreen.allItems.all();
    expect(items.length).toBeGreaterThan(1);
    const secondText = await items[1].getText();
    expect(secondText.length).toBeGreaterThan(0);
  });

  // ─── Filter ───

  test("filter({ hasNotText }) excludes matches", async ({ device }) => {
    const nonPremium = device
      .getByText("Item")
      .filter({ hasNotText: "Premium" });
    const count = await nonPremium.count();
    expect(count).toBeGreaterThan(0);
  });

  // ─── Selection ───

  test("tapping an item selects and deselects it", async ({ listScreen }) => {
    await listScreen.firstItem.tap();
    await expect(listScreen.selectedCount).toContainText("1 selected");

    await listScreen.firstItem.tap();
    await expect(listScreen.selectedCount).toContainText("0 selected");
  });

  // ─── all() ───

  test("all() returns array of element handles", async ({ listScreen }) => {
    const items = await listScreen.allItems.all();
    expect(items.length).toBeGreaterThan(0);
    const firstText = await items[0].getText();
    expect(firstText.length).toBeGreaterThan(0);
  });
});
