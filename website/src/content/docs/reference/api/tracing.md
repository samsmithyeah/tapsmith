---
title: Tracing
description: "Record step-by-step traces with screenshots, hierarchy, and network."
---

The `device.tracing` API provides programmatic control over trace recording.

### `device.tracing.start(options?)`

Start tracing. All subsequent device actions will be recorded.

```typescript
await device.tracing.start();
await device.tracing.start({ screenshots: true, snapshots: true });
```

**Options:**
| Option | Type | Default | Description |
|---|---|---|---|
| `screenshots` | `boolean` | `true` | Capture before/after screenshots |
| `snapshots` | `boolean` | `true` | Capture view hierarchy XML |
| `sources` | `boolean` | `true` | Include test source files |
| `network` | `boolean` | `true` | Capture HTTP/HTTPS traffic via proxy |
| `title` | `string` | — | Custom title for the trace |

### `device.tracing.stop(options?)`

Stop tracing and optionally write the trace archive.

```typescript
// Stop and save
await device.tracing.stop({ path: 'traces/my-test.zip' });

// Stop and discard
await device.tracing.stop();
```

Returns the path to the created zip file, or `undefined` if no path was specified.

### `device.tracing.group(name)` / `device.tracing.groupEnd()`

Group actions in the trace viewer for better organization.

```typescript
device.tracing.group('Login flow');
await device.getByText('Username', { exact: true }).tap();
await device.getByText('Username', { exact: true }).type('admin');
await device.getByRole('button', { name: 'Sign In' }).tap();
device.tracing.groupEnd();
```

### `device.tracing.startChunk(options?)` / `device.tracing.stopChunk(options?)`

Start a new trace chunk. Useful for splitting long test runs into multiple trace files.

```typescript
await device.tracing.startChunk();
// ... actions ...
await device.tracing.stopChunk({ path: 'traces/chunk-1.zip' });

await device.tracing.startChunk();
// ... more actions ...
await device.tracing.stopChunk({ path: 'traces/chunk-2.zip' });
```
