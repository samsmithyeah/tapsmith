import { describe, expect, test } from "../fixtures.js"
import { openScreen } from "../utils/app-reset.js"

// getByRole's `selected` filter against React Native's
// accessibilityState={{ selected }} on Android, in both directions and
// across a change of selection (PILOT-655): `selected: true` must match only
// the selected element and `selected: false` only the others — never the
// element whose state just flipped.
//
// Android-only: the ticket's report was Android, and iOS runs the same
// getByRole options through get-by-role-options.test.ts.
describe("getByRole selected (React Native accessibilityState)", () => {
  test("list rows: selected: true and false each match exactly, through select and deselect", async ({
    device,
  }) => {
    await openScreen(device, "/list")
    const item1Selected = device.getByRole("button", { name: "Item 1", exact: true, selected: true })
    const item1Unselected = device.getByRole("button", { name: "Item 1", exact: true, selected: false })

    await expect(item1Unselected).toHaveCount(1)
    await expect(item1Selected).toHaveCount(0)

    await device.getByRole("button", { name: "Item 1", exact: true }).tap()
    await expect(device.getByTestId("selected-count")).toHaveText("1 selected")
    await expect(item1Selected).toHaveCount(1)
    await expect(item1Unselected).toHaveCount(0)
    // Only the row that was tapped is selected.
    await expect(device.getByRole("button", { name: "Item 2", exact: true, selected: true })).toHaveCount(0)

    await item1Selected.tap()
    await expect(device.getByTestId("selected-count")).toHaveText("0 selected")
    await expect(item1Selected).toHaveCount(0)
    await expect(item1Unselected).toHaveCount(1)
  })

  test("bottom tabs: the selected filter follows the active tab", async ({ device }) => {
    await openScreen(device, "/tabs")
    await expect(device.getByRole("tab", { selected: true })).toHaveCount(1)
    await expect(device.getByRole("tab", { name: "Library", selected: true })).toHaveCount(1)
    await expect(device.getByRole("tab", { name: "Settings", selected: false })).toHaveCount(1)
    await expect(device.getByRole("tab", { name: "Settings", selected: true })).toHaveCount(0)

    await device.getByRole("tab", { name: "Settings", selected: false }).tap()
    await expect(device.getByRole("tab", { name: "Settings", selected: true })).toHaveCount(1)
    await expect(device.getByRole("tab", { name: "Library", selected: true })).toHaveCount(0)
    await expect(device.getByRole("tab", { name: "Library", selected: false })).toHaveCount(1)
  })
})
