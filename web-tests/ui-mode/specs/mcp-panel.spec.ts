// The MCP panel: the feed of tool calls made by coding agents that share this
// UI session. Its whole job is making agent activity visible while it happens.

import { test, expect } from "../fixtures.js"

const BASE_TIME = 1_700_000_000_000

function toolCall(o: {
  id: string
  tool: string
  status: "started" | "completed" | "error"
  resultSummary?: string
  error?: string
  durationMs?: number
  args?: Record<string, unknown>
}) {
  return {
    type: "mcp-tool-call" as const,
    id: o.id,
    tool: o.tool,
    args: o.args ?? {},
    status: o.status,
    resultSummary: o.resultSummary,
    error: o.error,
    durationMs: o.durationMs,
    timestamp: BASE_TIME,
  }
}

test.describe("MCP panel", () => {
  test("opens from the top rail", async ({ app, mcp }) => {
    void app
    await expect(mcp.root).toHaveCount(0)
    await mcp.toggle.click()
    await expect(mcp.root).toBeVisible()
  })

  test("reports the server listening with no agent attached", async ({ app, mcp }) => {
    const ui = app
    ui.send({ type: "mcp-status", running: true })
    await mcp.open()
    await expect(mcp.root).toContainText(/listening/i)
  })

  test("names attached agents", async ({ app, mcp }) => {
    const ui = app
    ui.send({
      type: "mcp-status",
      running: true,
      connectedCount: 2,
      clients: [
        { name: "claude-code", version: "1.0.0" },
        { name: "cursor", version: "0.4.2" },
      ],
    })
    await mcp.open()

    await expect(mcp.agents).toHaveCount(2)
    await expect(mcp.agents.first()).toContainText("claude-code")
  })

  test("groups repeat connections from one agent", async ({ app, mcp }) => {
    const ui = app
    ui.send({
      type: "mcp-status",
      running: true,
      connectedCount: 3,
      clients: [
        { name: "claude-code", version: "1.0.0" },
        { name: "claude-code", version: "1.0.0" },
        { name: "cursor", version: "0.4.2" },
      ],
    })
    await mcp.open()

    // Two pills, not three: the duplicate is collapsed with a count.
    await expect(mcp.agents).toHaveCount(2)
    await expect(mcp.agents.first()).toContainText("2")
  })

  test("streams a tool call from started to completed", async ({ app, mcp }) => {
    const ui = app
    await mcp.open()

    ui.send(toolCall({ id: "1", tool: "tapsmith_tap", status: "started" }))
    await expect(mcp.entries).toHaveCount(1)
    await expect(mcp.entry("tap")).toHaveClass(/started/)

    ui.send(
      toolCall({
        id: "1",
        tool: "tapsmith_tap",
        status: "completed",
        resultSummary: "tapped Tap area",
        durationMs: 240,
      }),
    )

    // Same call updated in place rather than a second row appended.
    await expect(mcp.entries).toHaveCount(1)
    await expect(mcp.entry("tap")).toHaveClass(/completed/)
    await expect(mcp.entry("tap")).toContainText("tapped Tap area")
  })

  test("marks a failed tool call", async ({ app, mcp }) => {
    const ui = app
    await mcp.open()

    ui.send(
      toolCall({
        id: "1",
        tool: "tapsmith_snapshot",
        status: "error",
        error: "device not responding",
      }),
    )

    await expect(mcp.entry("snapshot")).toHaveClass(/error/)
    await expect(mcp.entry("snapshot")).toContainText("device not responding")
  })

  test("keeps several calls in order", async ({ app, mcp }) => {
    const ui = app
    await mcp.open()

    ui.send(
      toolCall({ id: "1", tool: "tapsmith_list_tests", status: "completed" }),
      toolCall({ id: "2", tool: "tapsmith_run_tests", status: "completed" }),
      toolCall({ id: "3", tool: "tapsmith_read_trace", status: "started" }),
    )

    await expect(mcp.entries).toHaveCount(3)
    await expect(mcp.entries.nth(0)).toContainText("list_tests")
    await expect(mcp.entries.nth(2)).toContainText("read_trace")
  })

  test("clears the feed", async ({ app, mcp }) => {
    const ui = app
    await mcp.open()
    ui.send(toolCall({ id: "1", tool: "tapsmith_tap", status: "completed" }))
    await expect(mcp.entries).toHaveCount(1)

    await mcp.clear()
    await expect(mcp.entries).toHaveCount(0)
  })

  test("shows an empty state before any activity", async ({ app, mcp }) => {
    void app
    await mcp.open()
    await expect(mcp.emptyState).toBeVisible()
  })

  test("expands a call to show its full result", async ({ app, mcp }) => {
    const ui = app
    await mcp.open()

    ui.send(
      toolCall({
        id: "1",
        tool: "tapsmith_snapshot",
        status: "completed",
        resultSummary: "3 elements",
        args: { deviceSerial: "emulator-5554" },
      }),
    )

    const entry = mcp.entry("snapshot")
    await expect(entry).not.toContainText("deviceSerial")

    await entry.click()
    await expect(entry).toHaveClass(/expanded/)
    // The point of expanding is the arguments and full result, so assert those
    // rather than only the class that reveals them.
    await expect(entry).toContainText("deviceSerial")
  })
})
