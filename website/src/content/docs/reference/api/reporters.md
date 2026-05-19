---
title: Reporters
description: Built-in and custom reporters for test results.
---

Tapsmith includes a reporter system inspired by Playwright. Reporters receive lifecycle events during a test run and produce output in various formats.

## Configuration

Configure reporters in `tapsmith.config.ts`:

```typescript
import { defineConfig } from "tapsmith";

export default defineConfig({
  // Single reporter
  reporter: "list",

  // Reporter with options
  reporter: ["json", { outputFile: "results.json" }],

  // Multiple reporters
  reporter: ["list", ["json", { outputFile: "results.json" }]],
});
```

**Auto-detection:** When `reporter` is not set, Tapsmith uses `list` for local runs and `dot` for CI (detected via the `CI` environment variable). The `github` reporter is automatically added when running in GitHub Actions.

## Built-in reporters

| Reporter | Description | Default |
| --- | --- | --- |
| `list` | Detailed per-test output with status, name, and duration | Local runs |
| `line` | Concise single-line output, overwrites previous line | -- |
| `dot` | Minimal output: one character per test | CI runs |
| `json` | Structured JSON file with full test data | -- |
| `junit` | JUnit XML for CI system ingestion | -- |
| `html` | Self-contained interactive HTML report | -- |
| `github` | GitHub Actions annotations on failures | Auto in GH Actions |
| `blob` | Serialized data for shard merging | -- |

## Reporter options

**`json`**

| Option | Type | Default |
| --- | --- | --- |
| `outputFile` | `string` | `"tapsmith-results/results.json"` |

**`junit`**

| Option | Type | Default |
| --- | --- | --- |
| `outputFile` | `string` | `"tapsmith-results/results.xml"` |

**`html`**

| Option | Type | Default |
| --- | --- | --- |
| `outputFolder` | `string` | `"tapsmith-report"` |
| `open` | `"always" \| "never" \| "on-failure"` | `"on-failure"` |

**`blob`**

| Option | Type | Default |
| --- | --- | --- |
| `outputDir` | `string` | `"blob-report"` |

## Custom reporters

Implement the `TapsmithReporter` interface:

```typescript
import type { TapsmithReporter, FullResult } from "tapsmith";
import type { TestResult } from "tapsmith";

class MyReporter implements TapsmithReporter {
  onRunStart(config, fileCount) {
    console.log(`Running ${fileCount} test files`);
  }

  onTestEnd(test: TestResult) {
    console.log(`${test.status}: ${test.fullName}`);
  }

  onRunEnd(result: FullResult) {
    console.log(`Done in ${result.duration}ms`);
  }
}

export default MyReporter;
```

Use by path in config:

```typescript
export default defineConfig({
  reporter: [["./my-reporter.ts", {}]],
});
```

## TapsmithReporter interface

All types are importable from `"tapsmith"`:

```typescript
import type {
  TapsmithReporter,
  FullResult,
  TapsmithConfig,
  TestResult,
  SuiteResult,
} from "tapsmith";
```

```typescript
interface TapsmithReporter {
  onRunStart?(config: TapsmithConfig, fileCount: number): void;
  onTestFileStart?(filePath: string): void;
  onTestEnd?(test: TestResult): void;
  onTestFileEnd?(filePath: string, results: TestResult[]): void;
  onRunEnd?(result: FullResult): Promise<void> | void;
  onError?(error: Error): void;
}
```

## TestResult

```typescript
interface TestResult {
  name: string;
  fullName: string;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  error?: Error;
  screenshotPath?: string;
  tracePath?: string; // path to the trace archive (.zip) when tracing is enabled
  videoPath?: string; // path to the recorded MP4 when video is enabled and retained
  workerIndex?: number; // set in parallel mode: index of the worker that ran this test
}
```

## SuiteResult

```typescript
interface SuiteResult {
  name: string;
  durationMs: number;
  tests: TestResult[];
  suites: SuiteResult[]; // nested describe() blocks
}
```

## FullResult

```typescript
interface FullResult {
  status: "passed" | "failed";
  duration: number; // total wall-clock time in milliseconds (including setup)
  setupDuration?: number; // time spent on device provisioning, APK install, agent startup
  tests: TestResult[]; // flattened list of all test results
  suites: SuiteResult[]; // hierarchical suite tree (one per test file)
}
```

When `setupDuration` is present, console reporters show a timing breakdown:

```
Summary: 12 passed | 45.2s (setup 30.1s, tests 15.1s)
```
