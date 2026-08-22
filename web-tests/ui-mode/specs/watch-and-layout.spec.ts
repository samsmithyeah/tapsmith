// Watch mode feedback, theme, and the layout state the SPA persists.

import { test, expect } from "../fixtures.js"
import { GESTURES_FILE, idleSeed, twoProjectTree } from "../messages/scenarios.js"

const FILE = "gestures.test.ts"

test.describe("Watch mode", () => {
  test("marks a file as watched when the server confirms it", async ({ app, explorer }) => {
    const ui = app
    await explorer.node(FILE).hover()
    await expect(explorer.watchButtonFor(FILE)).toHaveAttribute("aria-pressed", "false")

    ui.send({ type: "watch-event", filePath: GESTURES_FILE, event: "watch-enabled" })

    await explorer.node(FILE).hover()
    await expect(explorer.watchButtonFor(FILE)).toHaveAttribute("aria-pressed", "true")
  })

  test("clears the mark when watching stops", async ({ app, explorer }) => {
    const ui = app
    ui.send({ type: "watch-event", filePath: GESTURES_FILE, event: "watch-enabled" })
    await explorer.node(FILE).hover()
    await expect(explorer.watchButtonFor(FILE)).toHaveAttribute("aria-pressed", "true")

    ui.send({ type: "watch-event", filePath: GESTURES_FILE, event: "watch-disabled" })
    await expect(explorer.watchButtonFor(FILE)).toHaveAttribute("aria-pressed", "false")
  })

  test("scopes a watch to one test", async ({ app, explorer }) => {
    const ui = app
    await explorer.expandAll()

    const target = "long press registers long press"
    const sibling = "swipe registers swipe"

    ui.send({
      type: "watch-event",
      filePath: GESTURES_FILE,
      testFilter: `Gestures screen > ${target}`,
      event: "watch-enabled",
    })

    await explorer.node(target).hover()
    await expect(explorer.watchButtonFor(target)).toHaveAttribute("aria-pressed", "true")
    // Its sibling must not inherit the watch.
    await explorer.node(sibling).hover()
    await expect(explorer.watchButtonFor(sibling)).toHaveAttribute("aria-pressed", "false")
  })

  test("scopes a watch to one project", async ({ ui, explorer }) => {
    ui.seed(idleSeed(twoProjectTree()))
    await ui.open()
    await explorer.expandAll()

    ui.send({
      type: "watch-event",
      filePath: GESTURES_FILE,
      projectName: "android",
      event: "watch-enabled",
    })

    // Both projects hold this file, in tree order android then ios. Only
    // android's copy should be marked, or a watch would fire runs on the wrong
    // device.
    const files = explorer.nodesOfType("file")
    await expect(files).toHaveCount(2)

    await files.nth(0).hover()
    await expect(files.nth(0).getByRole("button", { name: /^Watch / })).toHaveAttribute(
      "aria-pressed",
      "true",
    )
    await files.nth(1).hover()
    await expect(files.nth(1).getByRole("button", { name: /^Watch / })).toHaveAttribute(
      "aria-pressed",
      "false",
    )
  })

  test("the toolbar toggle tracks whether anything is watched", async ({ app, explorer }) => {
    const ui = app
    // The toggle reads "watch everything" while nothing is watched, and becomes
    // an off switch as soon as any single file is — it reflects "watching", not
    // "watching all".
    await expect(explorer.watchAllButton).toBeVisible()
    await expect(explorer.disableWatchButton).toHaveCount(0)

    ui.send({ type: "watch-event", filePath: GESTURES_FILE, event: "watch-enabled" })
    await expect(explorer.disableWatchButton).toBeVisible()

    ui.send({ type: "watch-event", filePath: GESTURES_FILE, event: "watch-disabled" })
    await expect(explorer.watchAllButton).toBeVisible()
  })
})

test.describe("Theme", () => {
  test("applies the chosen theme to the document", async ({ app, page, runControls }) => {
    void app
    await runControls.themeSelect.selectOption("light")
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light")

    await runControls.themeSelect.selectOption("dark")
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")
  })

  test("remembers the theme across a reload", async ({ app, page, runControls }) => {
    void app
    await runControls.themeSelect.selectOption("light")
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light")

    await page.reload()
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light")
    await expect(runControls.themeSelect).toHaveValue("light")
  })
})

test.describe("Layout", () => {
  test("remembers a resized pane across a reload", async ({ app, page, explorer }) => {
    void app
    const explorerPane = page.getByTestId("explorer-pane")
    const before = (await explorerPane.boundingBox())!.width

    const grip = page.getByRole("separator", { name: "Resize test explorer" })
    const gripBox = (await grip.boundingBox())!
    await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(gripBox.x + 120, gripBox.y + gripBox.height / 2, { steps: 6 })
    await page.mouse.up()

    const after = (await explorerPane.boundingBox())!.width
    expect(after).toBeGreaterThan(before + 50)

    await page.reload()
    await expect(explorer.nodes.first()).toBeVisible()
    const restored = (await explorerPane.boundingBox())!.width
    expect(Math.abs(restored - after)).toBeLessThan(5)
  })
})
