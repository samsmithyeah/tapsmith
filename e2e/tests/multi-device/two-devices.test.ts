import { describe, expect, test } from "../../fixtures.js"
import { HomeScreen } from "../../screens/home.screen.js"
import { LoginScreen } from "../../screens/login.screen.js"

// Two devices driven by one test (PILOT-310). Runs only under the
// `*-multi` configs, whose project declares `use.devices`; every other config
// ignores this folder. The test app has no shared-state screen yet, so this
// exercises the mechanics — both devices reset, driven and asserted from one
// body, with actions interleaved between them — rather than a conversation.

describe("Two devices in one test", () => {
  test("receives both devices, with `device` as the primary", async ({ device, devices }) => {
    expect(devices.length).toBe(2)
    expect(devices[0]).toBe(device)
    expect(devices[1]).not.toBe(device)
  })

  test("drives both apps independently", async ({ devices: [alice, bob] }) => {
    const aliceHome = new HomeScreen(alice)
    const bobHome = new HomeScreen(bob)
    await expect(aliceHome.header).toBeVisible()
    await expect(bobHome.header).toBeVisible()

    // Alice navigates; Bob stays on the home screen.
    await aliceHome.loginCard.tap()
    await expect(new LoginScreen(alice).heading).toBeVisible()
    await expect(bobHome.header).toBeVisible()
    await expect(new LoginScreen(bob).heading).not.toBeVisible()
  })

  test("actions on both devices can run concurrently", async ({ devices: [alice, bob] }) => {
    const aliceHome = new HomeScreen(alice)
    const bobHome = new HomeScreen(bob)
    await Promise.all([aliceHome.loginCard.tap(), bobHome.listCard.tap()])
    await expect(new LoginScreen(alice).heading).toBeVisible()
    await expect(bob.getByText("List", { exact: true })).toBeVisible()
  })
})
