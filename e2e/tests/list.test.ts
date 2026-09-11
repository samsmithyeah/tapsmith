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

// PILOT-287 follow-up: the all() snapshot contract, on a device. Handles from
// all() answer from the capture they were created from, children scoped off
// them resolve the row LIVE by index (like .nth(i)), and expect() re-queries.
// Pinned here because the follow-up tickets (PILOT-344/345/346/347) edit
// exactly this code; PILOT-346 (live all()) is expected to rewrite this test
// deliberately, not to make it pass by accident.
describe("List screen — all() snapshot semantics", () => {
  test.beforeAll(async ({ device }) => {
    await device.openDeepLink("tapsmithtest:///list")
  })

  test("a check on rows[i] and an action on rows[i] address the same captured row", async ({ device, listScreen }) => {
    // FlatList virtualises: only the rendered window (~10 rows) is in the tree.
    const rows = device.getByRole("button")
    const captured = await rows.all()
    expect(captured.length).toBeGreaterThanOrEqual(5)

    // Snapshot readers: no re-query, so a check and the action it guards agree.
    expect(await captured[2].isVisible()).toBe(true)
    expect(await captured[2].isEnabled()).toBe(true)
    await captured[2].tap()
    await expect(listScreen.selectedCount).toContainText("1 selected")
    await captured[2].tap() // deselect, leave the screen as we found it
    await expect(listScreen.selectedCount).toContainText("0 selected")
  })

  test("a captured handle keeps answering from its capture; expect() and nth() see the live list", async ({ device, listScreen }) => {
    // Android merges a button's children into one accessibility node, so the
    // rows here have no separately addressable children; the live-by-index
    // rule for scoped children (rows[i].getByRole(…)) is unit-tested.
    const rows = device.getByRole("button")
    const captured = await rows.all()
    expect(captured.length).toBeGreaterThanOrEqual(5)
    // Buttons include the header's back button, so locate Item 2 by text.
    const texts = await Promise.all(captured.map((h) => h.getText()))
    const idx = texts.findIndex((t) => t.includes("Item 2"))
    expect(idx).toBeGreaterThan(0)

    // Filter the list down to Item 3 and Item 30.
    const search = device.getByTestId("search-input")
    await search.type("Item 3")
    await expect(listScreen.itemCount).toHaveText("2 items")
    try {
      // The captured handle still answers from its capture (documented; live
      // all() is PILOT-346) …
      expect(await captured[idx].isVisible()).toBe(true)
      expect(await captured[idx].getText()).toContain("Item 2")
      // … while expect() and .nth() re-query by index: that index now holds
      // Item 3 or Item 30, and the captured last index is gone from the screen.
      await expect(rows.nth(idx)).toContainText("Item 3")
      await expect(rows.nth(idx)).not.toContainText("Item 2")
      await expect(captured[idx]).toBeVisible()
      await expect(captured[captured.length - 1]).not.toBeVisible()
      expect(await rows.nth(captured.length - 1).isHidden()).toBe(true)
    } finally {
      await search.clear()
      await expect(listScreen.itemCount).toHaveText("30 items")
    }
  })
})

// PILOT-345: scrollIntoView() judges visibility against the element the
// locator actually denotes — filter/and/or/scope and the positional index all
// apply — not against the raw selector's first match.
//
// Last in the file on purpose: it leaves the list scrolled, re-opening the deep
// link does not reset scroll position, and the per-file app reset restores it
// for the next file. (Scrolling back with `scrollIntoView({ direction: "down" })`
// is not reliable here: a screen-wide "down" swipe at the default distance
// starts above this FlatList, on the item-count text — PILOT-348.)
describe("List screen — scrollIntoView on a modified locator", () => {
  test.beforeAll(async ({ device }) => {
    await device.openDeepLink("tapsmithtest:///list")
    // The previous describe leaves focus in the search box and re-opening the
    // deep link does not dismiss the keyboard. scrollIntoView() swipes the
    // whole screen, and an "up" swipe starts inside the keyboard: Gboard
    // glide-types "GT" per swipe into the search box (0 items) instead of
    // scrolling the list (PILOT-348).
    await device.hideKeyboard()
  })

  test("scrollIntoView() on a filtered locator scrolls to THAT row", async ({ device }) => {
    // getByRole("button") alone is ambiguous (every rendered row, plus the
    // header's back button). Before the fix the scroll probe read that raw
    // selector, so this threw a strict-mode violation — or, for a raw selector
    // whose single visible match the filter excluded, reported "already
    // visible" and never swiped. The FlatList virtualises, so Item 25 is not
    // even in the tree until the list has been scrolled.
    const row = device.getByRole("button").filter({ hasText: "Item 25" })
    await row.scrollIntoView()
    await expect(row).toBeVisible()
  })
})
