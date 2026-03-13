import { test, expect, describe } from "pilot";
import { text, textContains, contentDesc } from "pilot";

describe("Library screen", () => {
  test("shows the app header and tagline", async ({ device }) => {
    await expect(device.element(text("DreamSpinner"))).toBeVisible();
    await expect(device.element(text("Unleash endless creativity"))).toBeVisible();
  });

  test("displays LIBRARY section heading", async ({ device }) => {
    await expect(device.element(text("LIBRARY"))).toBeVisible();
  });

  test("shows story cards in the library", async ({ device }) => {
    await expect(
      device.element(text("The Kebab at the End of Everything"))
    ).toBeVisible();
    await expect(
      device.element(text("The Butterflies That Vanished"))
    ).toBeVisible();
    await expect(
      device.element(text("The Dark House on Finley Lane"))
    ).toBeVisible();
    await expect(
      device.element(text("The Rainbow That Tasted Like Strawberry"))
    ).toBeVisible();
  });

  test("each story card shows date and page count", async ({ device }) => {
    await expect(
      device.element(textContains("8 March 2026"))
    ).toBeVisible();
    await expect(device.element(textContains("6 pages"))).toBeVisible();
  });

  test("Create story button is visible and labeled", async ({ device }) => {
    await expect(
      device.element(contentDesc("Create story"))
    ).toBeVisible();
    await expect(device.element(text("Create story"))).toBeVisible();
  });

  test("bottom navigation shows all tabs", async ({ device }) => {
    await expect(device.element(text("Library"))).toBeVisible();
    await expect(device.element(text("Create"))).toBeVisible();
    await expect(device.element(text("Credits"))).toBeVisible();
    await expect(device.element(text("Settings"))).toBeVisible();
  });
});
