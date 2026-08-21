// Connection handling: what the SPA shows when the socket drops, and that it
// rehydrates rather than starting from scratch when it comes back.
//
// `use-websocket.ts` reconnects on a 1s timer, and the real server re-pushes the
// tree and run state on every connect — `FakeUiServer.seed()` replays the same
// way, so these exercise the genuine rehydration path.

import { test, expect } from "../fixtures.js"
import { idleSeed, singleFileTree } from "../messages/scenarios.js"

test.describe("Connection", () => {
  test("reports the connected device in the top rail", async ({ app, runControls }) => {
    void app
    await expect(runControls.connection).toHaveText("emulator-5554")
  })

  test("shows Disconnected when the socket drops", async ({ app, runControls }) => {
    const ui = app
    ui.drop()
    await expect(runControls.disconnectedIndicator).toBeVisible()
  })

  test("reconnects and rehydrates the tree", async ({ app, explorer, runControls }) => {
    const ui = app
    expect(ui.connections).toBe(1)

    ui.drop()
    await expect(runControls.disconnectedIndicator).toBeVisible()

    // The 1s reconnect timer fires and the replayed seed restores the view.
    await expect.poll(() => ui.connections, { timeout: 5000 }).toBe(2)
    await expect(runControls.disconnectedIndicator).toHaveCount(0)
    await expect(explorer.node("gestures.test.ts")).toBeVisible()
  })

  test("rehydrates results recorded before the drop", async ({ ui, explorer, runControls }) => {
    // A reconnect replays whatever the server currently knows. Statuses that
    // were already reported must come back with it, not reset to idle.
    const passed = singleFileTree()
    passed[0].children![1].children![0].status = "passed"
    ui.seed(idleSeed(passed))
    await ui.open()

    await explorer.expandAll()
    await expect(explorer.nodesOfTypeWithStatus("test", "passed")).toHaveCount(1)

    ui.drop()
    await expect(runControls.disconnectedIndicator).toBeVisible()
    await expect.poll(() => ui.connections, { timeout: 5000 }).toBe(2)

    await explorer.expandAll()
    await expect(explorer.nodesOfTypeWithStatus("test", "passed")).toHaveCount(1)
  })

  test("does not issue any command of its own on reconnect", async ({ app, runControls }) => {
    const ui = app
    ui.clearReceived()

    ui.drop()
    await expect.poll(() => ui.connections, { timeout: 5000 }).toBe(2)
    await expect(runControls.disconnectedIndicator).toHaveCount(0)

    expect(ui.received).toEqual([])
  })

  test("disables run controls while disconnected", async ({ app, explorer }) => {
    const ui = app
    ui.drop()
    await expect(explorer.runAllButton).toBeDisabled()
  })

  test("surfaces a server error message", async ({ app, runControls }) => {
    const ui = app
    ui.send({ type: "error", message: "Device disconnected: emulator-5554" })
    await expect(runControls.errorBanner).toContainText("Device disconnected: emulator-5554")
  })
})
