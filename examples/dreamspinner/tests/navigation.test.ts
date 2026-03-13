import { test, expect, describe } from "pilot";
import { text, textContains, contentDesc } from "pilot";

describe("Bottom navigation", () => {
  test("can navigate to Settings tab", async ({ device }) => {
    await device.tap(text("Settings"));
    await expect(device.element(text("Settings"))).toBeVisible();
    await expect(
      device.element(text("Manage your family and app preferences"))
    ).toBeVisible();
    await expect(device.element(text("Child profiles"))).toBeVisible();
    await expect(device.element(text("Narration voice"))).toBeVisible();
  });

  test("can navigate to Credits tab", async ({ device }) => {
    await device.tap(text("Credits"));
    await expect(device.element(text("Credit packs"))).toBeVisible();
    await expect(device.element(text("Subscriptions"))).toBeVisible();
  });

  test("can navigate back to Library tab", async ({ device }) => {
    await device.tap(text("Library"));
    await expect(device.element(text("LIBRARY"))).toBeVisible();
    await expect(
      device.element(text("The Kebab at the End of Everything"))
    ).toBeVisible();
  });
});

describe("Story interaction", () => {
  test("can open a story detail from the library", async ({ device }) => {
    await device.tap(text("The Kebab at the End of Everything"));

    // Story detail screen shows title, cover, page count, and Start reading
    await expect(
      device.element(text("The Kebab at the End of Everything"))
    ).toBeVisible();
    await expect(device.element(text("6 pages"))).toBeVisible();
    await expect(device.element(text("Start reading"))).toBeVisible();
  });

  test("can go back to library from story detail", async ({ device }) => {
    await device.pressBack();
    await expect(device.element(text("LIBRARY"))).toBeVisible();
  });
});

describe("Create story flow", () => {
  test("can open the create story screen", async ({ device }) => {
    await device.tap(contentDesc("Create story"));

    await expect(device.element(text("Create a story"))).toBeVisible();
    await expect(
      device.element(text("Create a personalised story for your children"))
    ).toBeVisible();
    await expect(device.element(text("Start"))).toBeVisible();
    await expect(
      device.element(text("Feature your children in the story"))
    ).toBeVisible();
    await expect(
      device.element(text("AI-powered creativity"))
    ).toBeVisible();
  });

  test("shows credit balance", async ({ device }) => {
    await expect(
      device.element(textContains("credits"))
    ).toBeVisible();
  });

  test("can go back to library", async ({ device }) => {
    await device.pressBack();
    await expect(device.element(text("LIBRARY"))).toBeVisible();
  });
});
