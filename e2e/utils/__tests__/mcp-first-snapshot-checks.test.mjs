/**
 * Tests for the checks `verify-mcp-first-snapshot.mjs` applies to the first
 * MCP snapshot on a freshly booted iOS simulator (PILOT-462). The verifier's
 * risk is a check that cannot fire, so each failure shape it exists to catch
 * has a case here.
 */
import test from "node:test"
import assert from "node:assert/strict"
import {
  checkSnapshotResponse,
  resultText,
  splitJsonRpcLines,
} from "../mcp-first-snapshot-checks.mjs"

const ok = (text) => ({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text }] } })
const failed = (text) => ({
  jsonrpc: "2.0",
  id: 2,
  result: { content: [{ type: "text", text }], isError: true },
})

const SCREEN = '- [1] heading "Tapsmith Test App"\n- [2] scrollview'

test("a snapshot of the expected screen passes", () => {
  assert.deepEqual(checkSnapshotResponse(ok(SCREEN), { expectText: "Tapsmith Test App" }), [])
})

test("the PILOT-462 failure is caught twice over", () => {
  const problems = checkSnapshotResponse(failed("Error: Interrupting test"), {
    expectText: "Tapsmith Test App",
  })
  assert.equal(problems.length, 2)
  assert.match(problems[0], /tapsmith_snapshot failed: Error: Interrupting test/)
  assert.match(problems[1], /Interrupting test/)
})

test("any tool error fails, including the new actionable one", () => {
  const problems = checkSnapshotResponse(
    failed("Error: The app dev.tapsmith.testapp is not reachable through accessibility"),
    { expectText: "Tapsmith Test App" },
  )
  assert.equal(problems.length, 1)
  assert.match(problems[0], /not reachable through accessibility/)
})

test("an empty or wrong screen fails", () => {
  assert.equal(checkSnapshotResponse(ok("(empty screen)"), { expectText: "Tapsmith Test App" }).length, 1)
  assert.equal(checkSnapshotResponse(ok(""), { expectText: "Tapsmith Test App" }).length, 1)
})

test("a protocol error or a missing response fails", () => {
  assert.match(
    checkSnapshotResponse({ jsonrpc: "2.0", id: 2, error: { code: -32602, message: "bad" } }, {
      expectText: "x",
    })[0],
    /protocol error/,
  )
  assert.match(checkSnapshotResponse(undefined, { expectText: "x" })[0], /no response/)
})

test("resultText joins text blocks and ignores others", () => {
  assert.equal(
    resultText({ result: { content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] } }),
    "a\n\nb",
  )
  assert.equal(resultText({}), "")
})

test("splitJsonRpcLines frames complete lines and keeps the partial tail", () => {
  const { messages, nonJson, rest } = splitJsonRpcLines('{"id":1}\n\nbanner text\n{"id":2}\n{"id":')
  assert.deepEqual(messages, [{ id: 1 }, { id: 2 }])
  assert.deepEqual(nonJson, ["banner text"])
  assert.equal(rest, '{"id":')
})
