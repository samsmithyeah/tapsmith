# MCP Server

Tapsmith includes a built-in [MCP](https://modelcontextprotocol.io/) server that lets AI coding agents run tests, interact with devices, and inspect results through a standardized tool interface.

## Modes

The MCP server operates in two modes:

### SSE mode (recommended)

When running `tapsmith test --ui`, an SSE MCP endpoint is hosted alongside the UI. The agent shares the same daemon, device, and test session as the UI — test runs appear in the UI with full progress tracking, and both the agent and user share mutual exclusion (only one run at a time).

This mode has **16 tools** including test discovery, result browsing, watch mode, and session info.

To connect, copy the SSE URL from the MCP panel in the UI into any MCP client that supports SSE transport. For Claude Code, you can run:

```bash
claude mcp add tapsmith --transport sse http://localhost:9274/mcp
```

The MCP panel in the UI shows the connection status and a live activity feed of all tool calls.

### Stdio mode

Run `tapsmith mcp-server` as a standalone subprocess. The agent gets its own headless test session, daemon, and device, fully independent from any UI session.

This mode has **16 tools** including test discovery, result browsing, watch mode, stop, and session info. Test files and projects are discovered lazily on the first test-management tool call.

Codex CLI:

```bash
codex mcp add tapsmith -- npx tapsmith mcp-server
```

Claude Code:

```bash
claude mcp add tapsmith -- npx tapsmith mcp-server
```

Generic MCP stdio config:

```json
{
  "mcpServers": {
    "tapsmith": {
      "command": "npx",
      "args": ["tapsmith", "mcp-server"]
    }
  }
}
```

To use a non-default Tapsmith config, include the config flag in the server command:

```bash
codex mcp add tapsmith-ios -- npx tapsmith mcp-server --config tapsmith.config.ios.mjs
claude mcp add tapsmith-ios -- npx tapsmith mcp-server --config tapsmith.config.ios.mjs
```

If a UI server is already running, stdio mode will detect it and suggest connecting via SSE instead. Use SSE when you want the agent and browser UI to share one visible session; use stdio when you want a standalone agent-owned session.

## Tool Reference

### Device interaction tools (both modes)

#### `tapsmith_snapshot`

Get the current screen's accessibility tree with copy-paste-ready Tapsmith selectors for each interactive element. Use this first when writing tests to see what's on screen.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `device` | string | No | Device serial from `tapsmith_list_devices`. Uses the default device when omitted. |

Returns a text representation of the accessibility tree with suggested selectors like `device.getByRole("button", { name: "Login" })` for each interactive element.

#### `tapsmith_screenshot`

Capture a PNG screenshot of the device screen. Use when you need to visually verify what's on screen or when the accessibility tree is insufficient.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `device` | string | No | Device serial. Uses the default device when omitted. |

Returns a base64-encoded PNG image.

#### `tapsmith_test_selector`

Test a Tapsmith selector against the current screen. Returns whether it matches, how many elements match, and details about each match. Use to validate selectors before putting them in test code.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `selector` | string | Yes | Tapsmith selector string, e.g. `device.getByRole("button", { name: "Login" })` |
| `device` | string | No | Device serial. Uses the default device when omitted. |

Returns a JSON object with `matched` (boolean), `count` (number), and `elements` (array of matched elements with role, text, and bounds).

#### `tapsmith_tap`

Tap a UI element matching the given Tapsmith selector.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `selector` | string | Yes | Tapsmith selector, e.g. `device.getByRole("button", { name: "Login" })` |
| `device` | string | No | Device serial. Uses the default device when omitted. |

#### `tapsmith_type`

Type text into an element matching the selector.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `selector` | string | Yes | Tapsmith selector for the text field |
| `text` | string | Yes | Text to type |
| `clear` | boolean | No | Clear existing text before typing (default: false) |
| `device` | string | No | Device serial. Uses the default device when omitted. |

#### `tapsmith_swipe`

Swipe on the device screen in the given direction. Use to scroll or navigate between screens.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `direction` | string | Yes | One of: `up`, `down`, `left`, `right` |
| `device` | string | No | Device serial. Uses the default device when omitted. |

#### `tapsmith_press_key`

Press a device key.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `key` | string | Yes | Key name: `back`, `home`, `enter`, `tab`, `delete`, etc. |
| `device` | string | No | Device serial. Uses the default device when omitted. |

#### `tapsmith_launch_app`

Launch an app on the device.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `package` | string | Yes | Android package name or iOS bundle ID |
| `clear_data` | boolean | No | Clear app data before launching (default: false) |
| `device` | string | No | Device serial. Uses the default device when omitted. |

#### `tapsmith_list_devices`

List all connected mobile devices and emulators across all platforms. Returns serial numbers needed for the `device` parameter on other tools.

No parameters.

Returns a JSON array of device objects with `serial`, `model`, `platform` (android/ios), `os_version`, `is_emulator`, and `state`.

### Test execution tools (both modes)

#### `tapsmith_run_tests`

Run Tapsmith test files and return structured results. Only one test run can execute at a time. In SSE mode, runs appear in the UI with full progress tracking. In stdio mode, runs execute in the headless MCP session and results are available through `tapsmith_list_results`.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `files` | string[] | Yes | Absolute file paths or glob patterns. Use `tapsmith_list_tests` to find available files. |
| `test` | string | No | Run a specific test by its full name (e.g. `"Login screen > submits form"`). Only works with a single file. |
| `project` | string | No | Project name to target a specific platform/device (e.g. `"android"`, `"ios"`). Required when the same test file runs on multiple platforms. |
| `device` | string | No | Device serial (ignored in SSE mode — use `project` instead). |

**On success:** returns a summary like "All tests passed: 5 passed, 0 skipped (12.3s)".

**On failure:** returns a detailed report including:
- Failed test names with error messages
- Steps leading to the failure (from the trace)
- Device logs around the failure time
- Trace file path for further debugging with `tapsmith_read_trace`
- A screenshot at the moment of failure

#### `tapsmith_read_trace`

Read a Tapsmith trace archive (.zip) and return step-by-step test execution data. Use to debug why a test failed.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | string | Yes | Path to the trace `.zip` file |
| `include_screenshots` | boolean | No | Include base64 screenshots for each step (default: false) |
| `device_logs` | string | No | Include device logs: `errors` (default, error/warn only), `all`, or `none` |

Returns trace metadata (device, platform, test file, duration) followed by a step-by-step action list with status, selectors, durations, and error details.

### Test session tools (both modes)

These tools operate on the current MCP test session. In SSE mode that is the browser UI session; in stdio mode it is the standalone headless session created by `tapsmith mcp-server`.

#### `tapsmith_list_tests`

List all test files, projects, and test names discovered by the current MCP test session. Call this before `tapsmith_run_tests` to get exact file paths, test names, and project names.

No parameters.

Returns a hierarchical tree showing:
- Available projects
- Test files with absolute paths
- Describe blocks (suites)
- Individual test names with their full names (for use with `tapsmith_run_tests`)

#### `tapsmith_list_results`

Browse test results from the current session. Shows pass/fail/skip status, duration, and error messages.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `status` | string | No | Filter by status: `passed`, `failed`, or `skipped` |
| `file` | string | No | Filter by file path substring |
| `details` | boolean | No | Include trace steps for failed tests (default: false) |

Returns a summary with counts, then per-test results including status, full name, duration, project, file path, and (when `details: true`) the steps and device logs leading to the failure.

#### `tapsmith_stop_tests`

Stop the currently running test execution. Works whether the run was started by the agent or by the user in the UI.

No parameters.

#### `tapsmith_session_info`

Get configuration and environment info for the current test session. Useful for understanding the test environment before writing or running tests.

No parameters.

Returns session details: device serial, platform, app package, timeout, retries, and per-project settings (name, platform, package, test file count, dependencies).

#### `tapsmith_watch`

Toggle watch mode on a test file. When enabled, the file automatically re-runs on save.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `file` | string | Yes | Absolute path to the test file |
| `test` | string | No | Specific test full name to watch (watches the whole file if omitted) |
| `project` | string | No | Project name to scope the watch to |

Returns a message indicating whether watch mode was enabled or disabled.

## Typical workflows

### UI-shared workflow

1. **Start the UI:** `tapsmith test --ui`
2. **Connect your agent** to the SSE endpoint shown in the MCP panel
3. **Understand the environment:** call `tapsmith_session_info` to see platform, device, package, and project configuration
4. **Discover tests:** call `tapsmith_list_tests` to see the full test tree with file paths and test names
5. **Explore the screen:** use `tapsmith_snapshot` to see the accessibility tree with suggested selectors, then `tapsmith_test_selector` to validate a selector before using it
6. **Run tests:** call `tapsmith_run_tests` with file paths and optional test name / project filters. On failure, the response includes error details, trace steps, and a screenshot
7. **Review results:** use `tapsmith_list_results` to browse all results, optionally filtering by status or file. Pass `details: true` to see trace steps for failures
8. **Debug failures:** use `tapsmith_read_trace` with the trace file path from the failure report for step-by-step debugging
9. **Iterate:** toggle `tapsmith_watch` on files being actively developed for automatic re-runs on save

### Headless stdio workflow

1. **Register the server:** `codex mcp add tapsmith -- npx tapsmith mcp-server`
2. **Understand the environment:** call `tapsmith_session_info` to lazy-load config, connect a device, and show project settings
3. **Discover tests:** call `tapsmith_list_tests` to get file paths, test names, and project names from the headless session
4. **Explore the screen:** use `tapsmith_snapshot` and `tapsmith_test_selector` against the headless session's selected device
5. **Run tests:** call `tapsmith_run_tests`; results are stored in the headless session for `tapsmith_list_results`
6. **Iterate:** use `tapsmith_watch` to re-run watched files on save, or `tapsmith_stop_tests` to terminate a running headless test run

## Selector format

Device action tools (`tapsmith_tap`, `tapsmith_type`, `tapsmith_test_selector`) expect Tapsmith selector strings. These are the same expressions you'd write in test code:

```
device.getByRole("button", { name: "Login" })
device.getByText("Welcome")
device.getByText("Sign In", { exact: true })
device.getByDescription("Close menu")
device.getByTestId("submit-button")
device.getByPlaceholder("Email")
device.locator({ id: "com.myapp:id/input" })
```

Use `tapsmith_snapshot` to see suggested selectors for every interactive element on screen.

## Multi-project support

When the config defines multiple projects (e.g. `android` and `ios`), all session-aware tools respect project scoping:

- `tapsmith_run_tests` accepts a `project` parameter to target a specific project
- `tapsmith_list_tests` shows the full tree grouped by project
- `tapsmith_list_results` includes the project name for each result
- `tapsmith_watch` accepts a `project` parameter to scope the watch

Use `tapsmith_session_info` to see available projects and their configuration.

## Resources

The MCP server exposes a `tapsmith://api-reference` resource containing the complete Tapsmith API documentation. Agents can read this resource to understand available methods and their signatures without needing external documentation.
