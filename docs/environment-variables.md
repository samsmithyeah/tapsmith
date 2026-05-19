# Environment Variables

Reference for all environment variables recognized by Tapsmith.

Most users will never need to set any of these. They are primarily useful for debugging, CI customization, and advanced setups where the defaults do not apply.

## Daemon and Binary

| Variable | Description |
|---|---|
| `TAPSMITH_DAEMON_BIN` | Override the path to the `tapsmith-core` daemon binary. Checked before auto-resolution from npm packages, monorepo builds, and PATH. |
| `TAPSMITH_DAEMON_LOG` | Path to a file for daemon stdout/stderr. When set, the CLI redirects the spawned daemon's output to this file. Useful for debugging daemon-side behavior (MITM proxy, agent startup, etc.). |
| `TAPSMITH_REUSE_DAEMON` | When set (any truthy value), the CLI connects to an existing daemon without killing it. Used internally by the MCP server's `tapsmith_run_tests` tool to avoid destroying a daemon owned by UI mode. |

## Debugging

| Variable | Description |
|---|---|
| `TAPSMITH_DEBUG` | Enable debug logging in the TypeScript SDK (assertion polling, element resolution, etc.). Set to `1` or `true`. |
| `RUST_LOG` | Control Rust daemon log verbosity. Examples: `RUST_LOG=info`, `RUST_LOG=tapsmith_core=debug`. Useful for diagnosing MITM proxy issues, agent startup failures, and device communication problems. |

## iOS Network Capture

| Variable | Description |
|---|---|
| `TAPSMITH_REDIRECTOR_APP` | Override the path to the mitmproxy Redirector app binary. Default search order: (1) this env var, (2) `/Applications/Mitmproxy Redirector.app/Contents/MacOS/Mitmproxy Redirector`, (3) `~/.tapsmith/redirector/` (auto-extracted from brew cask). |

## CI and Reporters

| Variable | Description |
|---|---|
| `CI` | When set to `"true"`, Tapsmith auto-selects the `dot` reporter instead of `list`. Most CI providers set this automatically. |
| `GITHUB_ACTIONS` | When set (GitHub Actions sets it automatically), Tapsmith auto-adds the `github` reporter for inline annotations on test failures. |
| `GITHUB_STEP_SUMMARY` | Path to the GitHub Actions step summary file. The GitHub reporter writes a Markdown summary table when this is set. |

## Android

| Variable | Description |
|---|---|
| `ANDROID_HOME` | Path to the Android SDK. Used to find `adb`, `emulator`, and `avdmanager` binaries. Falls back to `ANDROID_SDK_ROOT`. |
| `ANDROID_SDK_ROOT` | Alternate path to the Android SDK (deprecated by Google in favor of `ANDROID_HOME`, but still supported as a fallback). |

## Internal (Set by Tapsmith)

These are set by Tapsmith internally and generally should not be modified by users.

| Variable | Description |
|---|---|
| `TAPSMITH_WORKER_ID` | Set by the CLI in parallel and watch mode. Identifies the current worker process. |
| `TAPSMITH_DAEMON_ADDRESS` | Comma-separated daemon addresses. Used internally by MCP server mode. |
| `TAPSMITH_UI_DEV_URL` | Development server URL for UI mode's frontend. Internal use only. |

## Examples

### Debugging a daemon issue

```bash
RUST_LOG=tapsmith_core=debug TAPSMITH_DAEMON_LOG=daemon.log npx tapsmith test
# Then inspect daemon.log for MITM proxy, agent startup, and device communication logs
```

### Running in CI with a custom daemon binary

```bash
TAPSMITH_DAEMON_BIN=/usr/local/bin/tapsmith-core npx tapsmith test
```

### Verbose SDK debug output

```bash
TAPSMITH_DEBUG=1 npx tapsmith test tests/flaky.test.ts
```
