# Watch Mode and UI Mode

Tapsmith offers two interactive development modes on top of the standard `npx tapsmith test` runner: **watch mode** for fast terminal-based iteration, and **UI mode** for a browser-based interactive test runner with MCP integration.

Both modes keep the daemon, device, and agent alive across re-runs. This eliminates the setup overhead that dominates cold test runs, bringing re-run times down to roughly 1--2 seconds.

## Watch Mode

### Starting watch mode

```bash
npx tapsmith test --watch
npx tapsmith test -w
```

You can combine `--watch` with other flags:

```bash
npx tapsmith test --watch --workers 2
npx tapsmith test -w tests/login.test.ts
```

### How it works

Watch mode starts the daemon, connects to a device, installs the agent, and then enters a persistent loop:

1. **Watches test files** using [chokidar](https://github.com/paulmillr/chokidar). The set of watched files is determined by the `testMatch` patterns in your config (default: `**/*.test.ts` and `**/*.spec.ts`).
2. **On file change**, forks a child process to run just the changed file. Each re-run gets a fresh Node.js ESM module cache, so changes to test files, helper modules, and page objects are all picked up automatically.
3. **Only re-runs the changed file** -- not the entire suite. If you change `tests/login.test.ts`, only that file runs.

The persistent device session is what makes this fast. A normal `npx tapsmith test` run pays the full cost of daemon startup, device detection, agent installation, and app launch on every invocation. Watch mode pays that cost once and then only resets the app before each re-run.

### Keyboard shortcuts

While watch mode is running, these keys are available:

| Key | Action |
|---|---|
| `a` | Run all test files |
| `f` | Re-run only previously failed tests |
| `Enter` | Re-run the last file(s) that were executed |
| `q` | Quit watch mode |

### Configuration

Watch mode uses the same `tapsmith.config.ts` as normal runs. No additional configuration is needed. The `testMatch` patterns control which files are watched, and all other options (timeout, retries, screenshot mode, trace config, etc.) apply as usual.

Watch mode also works with [projects](#multi-project-support). When your config defines multiple projects, watch mode detects which project(s) a changed file belongs to and re-runs it on the correct device. If a file matches multiple projects (e.g. both an Android and iOS project share `**/*.test.ts`), it re-runs on all matching devices.

### Multi-worker watch

When `workers > 1` and multiple devices are available, watch mode initializes a pool of persistent worker processes -- one per device. Re-runs are dispatched to available workers using work-stealing, so parallel re-runs happen naturally when you save multiple files in quick succession.

```bash
npx tapsmith test --watch --workers 4
```

Each worker gets its own daemon instance and device connection. Workers remain alive for the duration of the watch session.

If only one device is available despite `workers > 1`, watch mode falls back to single-worker mode automatically.

### New file detection

Watch mode detects new test files added while it is running. If you create a new file that matches your `testMatch` patterns, it is picked up and run immediately. Deleted files are removed from the watch set.

Changes to the config file (`tapsmith.config.ts`) are detected but not hot-reloaded. Watch mode prints a message asking you to restart.

## UI Mode

### Starting UI mode

```bash
npx tapsmith test --ui
```

This opens an interactive web-based test runner in your browser. The UI server picks an available port automatically and prints the URL to the terminal.

To set a specific port:

```bash
npx tapsmith test --ui --ui-port 8080
```

Like watch mode, UI mode keeps the daemon, device, and agent alive for the duration of the session.

### Features

The UI provides:

- **Interactive test tree** -- tests are listed in a tree structure, grouped by file and `describe` block. When projects are configured, tests are grouped by project first.
- **Click to run** -- click any test, file, or project node to run it. You can also run the entire suite.
- **Live progress** -- test results stream into the UI in real time as tests execute. You see pass/fail status, duration, and error details as each test completes.
- **Result browsing** -- after a run, browse results with error messages, stack traces, screenshots, and trace data inline.
- **Watch mode toggle** -- toggle file-level watching from the UI. When a file's watch is enabled, it re-runs automatically on save (the same mechanism as `--watch` mode).
- **Device screen mirror** -- the UI polls and displays the device screen, so you can see what the app looks like without switching windows.

### MCP integration

The UI server exposes a [Streamable HTTP](https://modelcontextprotocol.io/) MCP endpoint that AI coding agents (Claude Code, Cursor, Codex, etc.) can connect to. This gives agents 16 tools for test discovery, execution, result browsing, device interaction, and watch mode control -- all sharing the same session as the UI.

To connect an agent:

```bash
claude mcp add tapsmith --transport http http://localhost:<port>/mcp
```

Both the UI user and the MCP agent share the same test session. Runs triggered by either side appear in the UI, and mutual exclusion ensures only one test run happens at a time.

See [MCP Server](mcp-server.md) for the full list of tools and usage patterns.

### Multi-project support

When your config defines multiple projects, the UI groups tests by project name. Each project routes to its own device (Android emulator, iOS simulator, physical device, etc.).

```typescript
import { defineConfig } from "tapsmith";

export default defineConfig({
  projects: [
    {
      name: "Pixel 6",
      use: {
        platform: "android",
        avd: "Pixel_6_API_34",
        apk: "./android/app-debug.apk",
        launchEmulators: true,
      },
    },
    {
      name: "iPhone 16",
      use: {
        platform: "ios",
        simulator: "iPhone 16",
        app: "./ios/MyApp.app",
      },
    },
  ],
});
```

Running a test from the "Pixel 6" project routes it to the Android emulator; running one from "iPhone 16" routes it to the iOS simulator. The UI handles this routing transparently.

### Multi-worker UI

When `workers > 1`, the UI server initializes persistent worker processes (one per device), the same way watch mode does. Files are dispatched across workers in parallel, and per-worker device screens are displayed in the UI.

```bash
npx tapsmith test --ui --workers 4
```

### Mutual exclusion

Only one test run can be active at a time, whether triggered from the UI or from an MCP agent. If you click "Run" in the UI while an MCP agent is already running tests, the run is queued. Both sides see the same results.

## Comparison

| Feature | `test` | `--watch` | `--ui` |
|---|---|---|---|
| Fast re-run | No (full setup each time) | Yes (persistent session) | Yes (persistent session) |
| File watching | No | Yes | Yes (toggle per file) |
| Interactive UI | No | No (terminal only) | Yes (browser) |
| MCP server | No | No | Yes (SSE endpoint) |
| Multi-worker | Yes | Yes | Yes |
| Keyboard shortcuts | No | Yes (a/f/Enter/q) | N/A (browser UI) |
| Trace viewer integration | Post-run only | Post-run only | Inline in results |

## Tips

- **Use watch mode for focused development.** When you are iterating on a single test or a small set of tests, `--watch` gives you the fastest feedback loop without leaving the terminal.
- **Use UI mode for exploration and debugging.** When you need to browse results, inspect traces, or let an AI agent drive the tests, `--ui` provides the richer interface.
- **Watch and UI are mutually exclusive.** If you pass both `--watch` and `--ui`, the UI takes precedence (it has its own built-in watch capability).
- **Sharding is not supported.** Neither watch mode nor UI mode can be combined with `--shard`, since both are designed for interactive local development rather than CI distribution.
