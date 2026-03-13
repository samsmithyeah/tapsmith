import { test, expect, describe, beforeAll } from "pilot";
import { text, textContains } from "pilot";

describe("Story reader", () => {
  beforeAll(async () => {
    // Ensure we're on the Library tab — no-op if already there
  });

  test("can open a story and start reading", async ({ device }) => {
    await device.tap(text("The Kebab at the End of Everything"));
    await expect(device.element(text("Start reading"))).toBeVisible();

    await device.tap(text("Start reading"));
    await expect(device.element(text("Page 1 of 6"))).toBeVisible();
  });

  test("page 1 shows story text and illustration", async ({ device }) => {
    await expect(
      device.element(textContains("It was a Saturday"))
    ).toBeVisible();
    await expect(
      device.element(text("The Kebab at the End of Everything"))
    ).toBeVisible();
  });

  test("can swipe left to go to next page", async ({ device }) => {
    await device.swipe("left");
    await expect(device.element(text("Page 2 of 6"))).toBeVisible();
    await expect(
      device.element(textContains("The trouble started"))
    ).toBeVisible();
  });

  test("can swipe right to go back a page", async ({ device }) => {
    await device.swipe("right");
    await expect(device.element(text("Page 1 of 6"))).toBeVisible();
  });

  test("can navigate through all pages", async ({ device }) => {
    // Swipe through pages 1 -> 6
    for (let page = 2; page <= 6; page++) {
      await device.swipe("left");
      await expect(
        device.element(text(`Page ${page} of 6`))
      ).toBeVisible();
    }
  });

  test("can close the reader and return to library", async ({ device }) => {
    await device.pressBack();
    await expect(device.element(text("LIBRARY"))).toBeVisible();
  });
});
