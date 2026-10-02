/**
 * Pure helpers for `verify-mcp-first-snapshot.mjs`: framing the MCP server's
 * stdio JSON-RPC output and judging a `tapsmith_snapshot` result. Kept apart
 * from the script so they are unit-tested without a device
 * (`utils/__tests__/mcp-first-snapshot-checks.test.mjs`).
 */

/**
 * Split newline-delimited JSON-RPC output into parsed messages.
 * Returns the messages, the lines that were not JSON (anything the server
 * writes to stdout outside the protocol corrupts a real client, so the caller
 * reports them), and the incomplete trailing chunk to prepend to the next read.
 *
 * @param {string} buffer
 * @returns {{ messages: object[], nonJson: string[], rest: string }}
 */
export function splitJsonRpcLines(buffer) {
  const messages = []
  const nonJson = []
  const lines = buffer.split("\n")
  const rest = lines.pop() ?? ""
  for (const raw of lines) {
    const line = raw.trim()
    if (line === "") continue
    try {
      messages.push(JSON.parse(line))
    } catch {
      nonJson.push(line)
    }
  }
  return { messages, nonJson, rest }
}

/** The text of a `tools/call` result's content blocks, joined. */
export function resultText(response) {
  const content = response?.result?.content
  if (!Array.isArray(content)) return ""
  return content
    .map((block) => (typeof block?.text === "string" ? block.text : ""))
    .join("\n")
}

/**
 * Judge a `tapsmith_snapshot` JSON-RPC response. Returns the problems found;
 * an empty list means the snapshot is a real read of the expected screen.
 *
 * @param {object} response the JSON-RPC response to `tools/call`
 * @param {{ expectText: string }} options text the screen must contain
 * @returns {string[]}
 */
export function checkSnapshotResponse(response, { expectText }) {
  if (!response) return ["no response from the MCP server"]
  if (response.error) {
    return [`the MCP server returned a protocol error: ${JSON.stringify(response.error)}`]
  }
  const text = resultText(response)
  const problems = []
  if (response.result?.isError) {
    problems.push(`tapsmith_snapshot failed: ${text.slice(0, 500) || "(no message)"}`)
  }
  if (text.includes("Interrupting test")) {
    problems.push("the result surfaces XCUITest's internal \"Interrupting test\"")
  }
  if (!response.result?.isError && !text.includes(expectText)) {
    problems.push(
      `the snapshot does not contain "${expectText}" — got: ${text.slice(0, 300) || "(empty)"}`,
    )
  }
  return problems
}
