# Multi-Device Tests

Drive two (or more) app sessions from a single test — Alice sends a message,
Bob sees it arrive. This is the mobile analogue of Playwright's
[multi-context tests](https://playwright.dev/docs/api/class-browsercontext):
a test that holds several isolated sessions and interleaves actions between
them.

## A context is a device

A Playwright context is a cheap in-process isolation boundary. Mobile has no
equivalent: there is one foreground app instance per device, and iOS has no
multi-user or app-cloning escape hatch. **A Tapsmith "context" is therefore a
whole device.** Two logged-in users means two emulators or simulators, each
with the app installed, each running its own Tapsmith daemon and agent, and
each reset before the test the same way a single device would be.

The cost follows from that: a two-device test occupies two device slots, so a
project that declares two devices per test halves the parallelism of the
bucket it runs in.

## Declaring the device group

Devices are declared on a **project** with `use.devices`. Either a count —

```typescript
import { defineConfig } from "tapsmith";

export default defineConfig({
  package: "com.example.chat",
  projects: [
    {
      name: "chat",
      testMatch: ["**/multi-user/**"],
      use: { platform: "android", avd: "Pixel_9_API_35", devices: 2 },
    },
  ],
});
```

— which names the members `device-1` and `device-2`, or a list of named
members:

```typescript
use: {
  platform: "ios",
  simulator: "iPhone 17",
  devices: [{ name: "alice" }, { name: "bob" }],
}
```

Names appear on every trace event the device produces, on its failure
screenshots, and as the `device` argument the MCP tools accept, so pick names
the test reads well with.

A member can be pinned to a specific serial or UDID:

```typescript
devices: [
  { name: "alice", device: "emulator-5554" },
  { name: "bob",   device: "emulator-5556" },
]
```

Pinning is optional for emulators and simulators — Tapsmith provisions them
the way it provisions extra workers — and **required for physical iOS
devices** beyond the first, which cannot be auto-picked. A group with pinned
members always runs as a single worker.

`devices` is device-shaping, like `platform` or `avd`: it can only be set on a
project's `use`. Calling `test.use({ devices })` throws, because the worker's
group is bound before any test file is imported.

## Writing the test

Tests receive the group as the `devices` fixture, in declaration order.
`device` remains an alias for `devices[0]`, so screen objects and helpers
written for one device keep working unchanged.

```typescript
import { expect, test } from "tapsmith";
import { ChatScreen } from "./screens/chat.screen.js";

test("alice messages bob", async ({ devices: [alice, bob] }) => {
  const aliceChat = new ChatScreen(alice);
  const bobChat = new ChatScreen(bob);

  await aliceChat.login("alice");
  await bobChat.login("bob");

  await aliceChat.send("Hi Bob");

  await expect(bobChat.message("Hi Bob")).toBeVisible();
});
```

Every `Device`, `ElementHandle` and `expect` call is scoped to its own device,
so the two sessions can be driven concurrently:

```typescript
await Promise.all([aliceChat.login("alice"), bobChat.login("bob")]);
```

The other fixtures are unchanged: `request` is host-side and shared;
`platform` and `projectName` describe the project, which is the same for every
member of the group.

## What happens per device

Everything Tapsmith does for one device, it does for each member of the group:

- **Provisioning.** Each member gets its own daemon, agent and app install.
  Emulators and simulators are booted or cloned when there are not enough
  online, exactly as for extra workers.
- **App reset.** The declared `appReset` / `appResetScope` policy runs on every
  device before the scope, **concurrently**, so a warm reset costs one round
  trip rather than one per device. A prepared launch (the startup launch, a UI
  mode background preparation) is consumed per device.
- **Readiness and recovery.** The per-test session check covers every member;
  an infrastructure failure on any of them recovers the whole group and
  retries the file, since the retried file's `beforeAll` expects all of them
  fresh.
- **Failure screenshots.** One per device. The primary's is linked from the
  test result; the others sit beside it with the member name as a suffix
  (`<test>-bob-<time>.png`).
- **Video** is recorded on the primary device only.

## Traces

A multi-device test records **one trace archive**: the interleaving is the
story, and it needs to live in one file.

- Every action, assertion and device-log line carries the `deviceId` of the
  device that produced it, and the trace's metadata lists every device of the
  group (`devices`, primary first) with its own pixel ratio and platform.
- The trace viewer shows **one screenshot pane per device, side by side**. The
  pane of the device that acted is outlined and follows the Action / Before /
  After stages; the other panes show that device's state at the same moment
  (its latest capture before the step, or its next capture after it). Bounds
  are scaled by each device's own pixel ratio. Clicking another pane selects
  it, and pick mode then resolves locators against *that* device's captured
  hierarchy.
- The filmstrip splits into **one lane per device**, so a two-user conversation
  reads as two rows on one timeline. Every action row carries a device badge,
  and the Metadata tab lists every device.
- The Console and Network tabs offer a **filter pill per device**; network rows
  show which device's proxy captured them. The Hierarchy tab defaults to the
  acting device's tree and has a toggle to view the other device's tree at the
  frame its pane displays. Device and daemon log lines keep the timestamp the
  daemon recorded, so lines from two devices interleave in true order.
- `tapsmith_read_trace` prefixes each step with the device name and prints one
  device-log section per device.

UI mode's live trace view renders the same panes, lanes and filters for a test
that ran on a device group.

## Run modes

Device groups work in every run mode. Each mode holds one group per worker:

| Mode | How the group is provisioned |
| --- | --- |
| `tapsmith test` (sequential) | The primary is set up as usual; the other members get their own daemons on free ports before the first file runs. Switching to a project with a different group tears the previous one down. |
| `tapsmith test --workers N` | Each worker receives `N × groupSize` device slots; the dispatcher provisions that many devices and hands each worker its chunk. A group project's own `workers` should be kept low. |
| `--ui` and `--watch` | Worker 0 adopts the CLI's group; further workers get their own. The device pane has one tab per member (labelled `<worker> · <name>`), the **All** view tiles every member, and pick mode and mirror gestures target the member whose tab is open. |
| `tapsmith mcp-server` | A group project resolves its own set of daemons; `tapsmith_run_tests` runs against all of them. Device tools accept a member's **name** (`device: "bob"`) in place of a serial, and `tapsmith_session_info` lists each member. |

## Limits

- **Platform is per project.** All members of a group run the same platform
  and the same app build — a group is one project. A test that needs Android
  *and* iOS in one body is not supported.
- **One foreground app per device.** A member is a device, so `devices: 3`
  needs three emulators or simulators.
- **Boot time.** Emulators and simulators boot serially; a group project's
  startup is roughly `groupSize` times a single device's.
- **CI.** Give group tests their own job rather than a shard: the per-shard
  matrix boots one device per runner. Tapsmith's own `Multi-device` jobs in
  `e2e-android.yml` and `e2e-ios.yml` run a suite (`e2e/tests/multi-device/`)
  in which two users chat through a server the test hosts. Both jobs boot
  the group's two devices up front and pin the member with `device` (from an
  environment variable the workflow exports): a second cold device launched
  on demand once the primary is up can outlast the boot and agent-start
  waits on a busy hosted runner. Two booted simulators also exceed what a
  standard hosted macOS runner can drive at usable speed, so the iOS job is
  advisory there; give it a larger runner to make it a required check. Those jobs run the
  `e2e/tapsmith.config.{android,ios}-multi-ci.mjs` configs, whose app paths
  point at the artifacts the workflow stages under `e2e/fixtures/`; the
  `*-multi.mjs` configs beside them are the local-development versions that
  use the repo's own build output.
