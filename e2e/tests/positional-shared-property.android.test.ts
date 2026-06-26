import { describe, expect, test } from "../fixtures.js";
import { resetApp } from "../utils/app-reset.js";

// Regression: `.last()/.nth()` must ACT on the resolved element even when the
// match shares its only identifying a11y property with an earlier sibling.
//
// Filtering the list to "Item 3" leaves exactly two rows — "Item 3" and
// "Item 30" — whose category labels both read "Basic" and carry NO testID. So
// `getByText("Basic").last()` resolves to Item 30's label. A bare `text("Basic")`
// selector would make the agent act on Item 3 (first match); instead the handle
// dispatches by the resolved element's agent-cached id, so the action lands on
// Item 30, leaving Item 3 untouched.
//
// Android-only: iOS collapses each row Button's children into its label, so the
// inner "Basic" Text is not an addressable element there (and the rows expose
// distinct identifiers anyway), making this shared-property scenario specific to
// the Android view hierarchy.
describe("positional action on shared-property matches", () => {
  test("last().tap() acts on the resolved row, not the first shared-text match", async ({
    device,
  }) => {
    await resetApp(device, "/list");

    await device.getByTestId("search-input").type("Item 3");
    // Filter settles to exactly the two "Item 3*" rows.
    await expect(device.getByTestId("item-count")).toHaveText("2 items");
    // Dismiss the soft keyboard — otherwise the first tap on a row is consumed
    // closing the keyboard instead of toggling selection.
    await device.hideKeyboard();

    const basics = device.getByText("Basic", { exact: true });
    await expect(basics).toHaveCount(2);

    await basics.last().tap();

    // The SECOND "Basic" belongs to Item 30 — it (and only it) must be selected.
    await expect(
      device.getByRole("button", { name: "Item 30", selected: true }),
    ).toBeVisible();
    expect(
      await device
        .getByRole("button", { name: "Item 3", selected: true })
        .exists(),
    ).toBe(false);
    await expect(device.getByTestId("selected-count")).toHaveText("1 selected");
  });
});
