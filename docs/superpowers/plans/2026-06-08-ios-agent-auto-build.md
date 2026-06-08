# iOS Simulator Agent Auto-Build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically build the iOS simulator agent from bundled source when the prebuilt xctestrun's SDK version doesn't match the user's installed Xcode SDK, caching the result for future runs.

**Architecture:** A new `ios-simulator-build.ts` module detects SDK mismatches by comparing the xctestrun filename's SDK version against `xcrun --show-sdk-version`. On mismatch, it builds the agent via unsigned `xcodebuild build-for-testing` and caches the output to `~/.tapsmith/ios-simulator-agent/`. The resolution order in `findSimulatorXctestrun()` is updated to check this cache first.

**Tech Stack:** TypeScript, xcodebuild, xcrun, Vitest

---

### Task 1: Add `extractSdkVersion()` helper to `ios-device-resolve.ts`

**Files:**
- Modify: `packages/tapsmith/src/ios-device-resolve.ts`
- Test: `packages/tapsmith/src/__tests__/ios-simulator-build.test.ts`

- [ ] **Step 1: Write the test**

Create `packages/tapsmith/src/__tests__/ios-simulator-build.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { extractSdkVersion } from '../ios-device-resolve.js';

describe('extractSdkVersion()', () => {
  it('extracts SDK version from simulator xctestrun filename', () => {
    expect(extractSdkVersion(
      '/path/to/TapsmithAgentUITests_TapsmithAgentUITests_iphonesimulator18.5-arm64.xctestrun',
    )).toBe('18.5');
  });

  it('extracts SDK version from full path with nested dirs', () => {
    expect(extractSdkVersion(
      '/Users/sam/.tapsmith/ios-simulator-agent/TapsmithAgentUITests_TapsmithAgentUITests_iphonesimulator26.0-arm64.xctestrun',
    )).toBe('26.0');
  });

  it('returns undefined for non-simulator xctestrun', () => {
    expect(extractSdkVersion(
      '/path/to/TapsmithAgentUITests_iphoneos26.4-arm64.xctestrun',
    )).toBeUndefined();
  });

  it('returns undefined for unrelated filenames', () => {
    expect(extractSdkVersion('/path/to/some-file.txt')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/tapsmith && npx vitest run src/__tests__/ios-simulator-build.test.ts`
Expected: FAIL — `extractSdkVersion` is not exported

- [ ] **Step 3: Implement `extractSdkVersion()`**

Add to the bottom of `packages/tapsmith/src/ios-device-resolve.ts`, before the closing of the file:

```typescript
/**
 * Extract the iOS simulator SDK version from an xctestrun filename.
 * e.g. "…_iphonesimulator18.5-arm64.xctestrun" → "18.5"
 */
export function extractSdkVersion(xctestrunPath: string): string | undefined {
  const match = path.basename(xctestrunPath).match(/iphonesimulator([\d.]+)-/);
  return match?.[1];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/tapsmith && npx vitest run src/__tests__/ios-simulator-build.test.ts`
Expected: 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/tapsmith/src/ios-device-resolve.ts packages/tapsmith/src/__tests__/ios-simulator-build.test.ts
git commit -m "feat: add extractSdkVersion() for xctestrun SDK detection"
```

---

### Task 2: Add cache check to `findSimulatorXctestrun()` resolution order

**Files:**
- Modify: `packages/tapsmith/src/ios-device-resolve.ts`
- Test: `packages/tapsmith/src/__tests__/ios-simulator-build.test.ts`

- [ ] **Step 1: Write the test**

Add to `packages/tapsmith/src/__tests__/ios-simulator-build.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { extractSdkVersion } from '../ios-device-resolve.js';

// ... (keep existing extractSdkVersion tests above)

vi.mock('node:fs');
vi.mock('node:os');

const { mockResolve } = vi.hoisted(() => ({
  mockResolve: vi.fn(),
}));

vi.mock('node:module', () => ({
  createRequire: () => ({ resolve: mockResolve }),
}));

const existsSync = vi.mocked(fs.existsSync);
const readdirSync = vi.mocked(fs.readdirSync);
const statSync = vi.mocked(fs.statSync);
const homedir = vi.mocked(os.homedir);

describe('findSimulatorXctestrun()', () => {
  beforeEach(() => {
    vi.resetModules();
    existsSync.mockReset();
    readdirSync.mockReset();
    statSync.mockReset();
    mockResolve.mockReset();
    homedir.mockReturnValue('/Users/test');
  });

  it('returns cached xctestrun from ~/.tapsmith/ios-simulator-agent/ when present', async () => {
    const cacheDir = '/Users/test/.tapsmith/ios-simulator-agent';
    const xctestrun = 'TapsmithAgentUITests_TapsmithAgentUITests_iphonesimulator26.0-arm64.xctestrun';

    readdirSync.mockImplementation((dir) => {
      if (String(dir) === cacheDir) return [xctestrun] as unknown as fs.Dirent[];
      throw new Error('ENOENT');
    });
    statSync.mockReturnValue({ mtimeMs: Date.now() } as fs.Stats);

    const { findSimulatorXctestrun } = await import('../ios-device-resolve.js');
    const result = findSimulatorXctestrun();
    expect(result).toBe(path.join(cacheDir, xctestrun));
  });
});
```

Note: this test needs `vi.resetModules()` + dynamic import since `findSimulatorXctestrun` uses module-level `createRequire`. The `extractSdkVersion` tests above should be kept as static imports (they're pure functions, no mocking needed).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/tapsmith && npx vitest run src/__tests__/ios-simulator-build.test.ts`
Expected: FAIL — the cache directory is not checked yet

- [ ] **Step 3: Update `findSimulatorXctestrun()`**

In `packages/tapsmith/src/ios-device-resolve.ts`, replace the `findSimulatorXctestrun()` function body. Add the cache check as the new step 1:

```typescript
export function findSimulatorXctestrun(): string | undefined {
  // 1. Auto-build cache (SDK-matched local build).
  const cacheDir = path.join(os.homedir(), '.tapsmith', 'ios-simulator-agent');
  const cached = newestSimulatorXctestrunIn(cacheDir);
  if (cached) return cached;

  // 2. Try the prebuilt npm package for the current architecture.
  const arch = process.arch;
  const pkg = `@tapsmith/agent-ios-simulator-${arch}`;
  try {
    const pkgJsonPath = require.resolve(`${pkg}/package.json`);
    const pkgDir = path.dirname(pkgJsonPath);
    const match = newestSimulatorXctestrunIn(pkgDir);
    if (match) return match;
  } catch {
    // Package not installed — fall through.
  }

  // 3. DerivedData scan (local Xcode builds).
  const root = path.join(os.homedir(), 'Library', 'Developer', 'Xcode', 'DerivedData');
  let dirs: string[];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return undefined;
  }
  const candidates: string[] = [];
  for (const d of dirs) {
    if (!d.startsWith('TapsmithAgent-')) continue;
    const productsDir = path.join(root, d, 'Build', 'Products');
    let entries: string[];
    try {
      entries = fs.readdirSync(productsDir);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (
        e.endsWith('.xctestrun') &&
        e.includes('iphonesimulator') &&
        !e.endsWith('.patched.xctestrun')
      ) {
        candidates.push(path.join(productsDir, e));
      }
    }
  }
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return candidates[0];
}
```

- [ ] **Step 4: Run tests**

Run: `cd packages/tapsmith && npx vitest run src/__tests__/ios-simulator-build.test.ts`
Expected: All tests pass

- [ ] **Step 5: Run typecheck**

Run: `cd packages/tapsmith && npm run typecheck`
Expected: Clean

- [ ] **Step 6: Commit**

```bash
git add packages/tapsmith/src/ios-device-resolve.ts packages/tapsmith/src/__tests__/ios-simulator-build.test.ts
git commit -m "feat: add auto-build cache to simulator xctestrun resolution order"
```

---

### Task 3: Create `ios-simulator-build.ts` with SDK detection and build function

**Files:**
- Create: `packages/tapsmith/src/ios-simulator-build.ts`
- Test: `packages/tapsmith/src/__tests__/ios-simulator-build.test.ts`

- [ ] **Step 1: Write tests for `getInstalledSimulatorSdkVersion()`**

Add to `packages/tapsmith/src/__tests__/ios-simulator-build.test.ts`:

```typescript
import { execFileSync } from 'node:child_process';

vi.mock('node:child_process');

const execFileSyncMock = vi.mocked(execFileSync);

describe('getInstalledSimulatorSdkVersion()', () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
  });

  it('returns SDK version from xcrun', async () => {
    execFileSyncMock.mockReturnValue('26.0\n');
    const { getInstalledSimulatorSdkVersion } = await import('../ios-simulator-build.js');
    expect(getInstalledSimulatorSdkVersion()).toBe('26.0');
  });

  it('returns undefined when xcrun fails', async () => {
    execFileSyncMock.mockImplementation(() => { throw new Error('xcrun not found'); });
    const { getInstalledSimulatorSdkVersion } = await import('../ios-simulator-build.js');
    expect(getInstalledSimulatorSdkVersion()).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/tapsmith && npx vitest run src/__tests__/ios-simulator-build.test.ts`
Expected: FAIL — `ios-simulator-build.js` doesn't exist

- [ ] **Step 3: Create `ios-simulator-build.ts`**

Create `packages/tapsmith/src/ios-simulator-build.ts`:

```typescript
import { execFileSync, execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveIosAgentDir } from './build-ios-agent.js';
import { extractSdkVersion, findSimulatorXctestrun } from './ios-device-resolve.js';

const CACHE_DIR = path.join(os.homedir(), '.tapsmith', 'ios-simulator-agent');
const SDK_VERSION_FILE = path.join(CACHE_DIR, '.sdk-version');

export function getInstalledSimulatorSdkVersion(): string | undefined {
  try {
    return execFileSync('xcrun', ['--show-sdk-version', '--sdk', 'iphonesimulator'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

export async function buildSimulatorAgent(sdkVersion: string): Promise<string> {
  const agentDir = resolveIosAgentDir();
  const xcodeproj = path.join(agentDir, 'TapsmithAgent.xcodeproj');
  if (!fs.existsSync(xcodeproj)) {
    throw new Error(
      `iOS agent source not found at ${agentDir}. ` +
        'Reinstall tapsmith or clone the monorepo.',
    );
  }

  const buildDir = path.join(CACHE_DIR, 'build');
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const args = [
    'build-for-testing',
    '-project', xcodeproj,
    '-scheme', 'TapsmithAgentUITests',
    '-destination', 'generic/platform=iOS Simulator',
    '-derivedDataPath', buildDir,
    'ARCHS=arm64', 'ONLY_ACTIVE_ARCH=NO',
    'CODE_SIGNING_ALLOWED=NO',
  ];

  await new Promise<void>((resolve, reject) => {
    const proc = execFile('xcodebuild', args, { maxBuffer: 10 * 1024 * 1024 }, (err) => {
      if (err) reject(new Error(`xcodebuild failed (exit ${err.code}). Run with --verbose for details.`));
      else resolve();
    });
    proc.stderr?.pipe(process.stderr);
  });

  // Copy xctestrun + test runner bundle to cache dir
  const productsDir = path.join(buildDir, 'Build', 'Products');
  const entries = fs.readdirSync(productsDir);
  const xctestrunFile = entries.find(
    (e) => e.endsWith('.xctestrun') && e.includes('iphonesimulator') && !e.endsWith('.patched.xctestrun'),
  );
  if (!xctestrunFile) {
    throw new Error('xcodebuild succeeded but no .xctestrun file found in build output.');
  }

  // Copy xctestrun to cache root
  fs.copyFileSync(path.join(productsDir, xctestrunFile), path.join(CACHE_DIR, xctestrunFile));

  // Copy Debug-iphonesimulator bundle
  const debugDir = path.join(productsDir, 'Debug-iphonesimulator');
  const cachedDebugDir = path.join(CACHE_DIR, 'Debug-iphonesimulator');
  if (fs.existsSync(cachedDebugDir)) fs.rmSync(cachedDebugDir, { recursive: true, force: true });
  if (fs.existsSync(debugDir)) fs.cpSync(debugDir, cachedDebugDir, { recursive: true });

  // Write SDK version marker
  fs.writeFileSync(SDK_VERSION_FILE, sdkVersion);

  return path.join(CACHE_DIR, xctestrunFile);
}

export async function ensureSimulatorAgent(): Promise<string> {
  const found = findSimulatorXctestrun();
  if (!found) {
    throw new Error(
      'No simulator xctestrun found. Install @tapsmith/agent-ios-simulator-arm64 ' +
        'or build the simulator agent with xcodebuild.',
    );
  }

  const installedSdk = getInstalledSimulatorSdkVersion();
  if (!installedSdk) {
    // Can't detect SDK — use whatever we found, let xcodebuild fail if there's a real problem
    return found;
  }

  const xctestrunSdk = extractSdkVersion(found);
  if (!xctestrunSdk || xctestrunSdk === installedSdk) {
    return found;
  }

  // Check if cache already has a build for this SDK
  if (fs.existsSync(SDK_VERSION_FILE)) {
    const cachedSdk = fs.readFileSync(SDK_VERSION_FILE, 'utf-8').trim();
    if (cachedSdk === installedSdk) {
      // Cache is valid but findSimulatorXctestrun() didn't return it — shouldn't happen,
      // but re-resolve to be safe
      const reFound = findSimulatorXctestrun();
      if (reFound && extractSdkVersion(reFound) === installedSdk) return reFound;
    }
  }

  console.log(`Building iOS agent for SDK ${installedSdk}... (cached for future runs)`);
  return buildSimulatorAgent(installedSdk);
}
```

- [ ] **Step 4: Run tests**

Run: `cd packages/tapsmith && npx vitest run src/__tests__/ios-simulator-build.test.ts`
Expected: All tests pass

- [ ] **Step 5: Run typecheck**

Run: `cd packages/tapsmith && npm run typecheck`
Expected: Clean

- [ ] **Step 6: Commit**

```bash
git add packages/tapsmith/src/ios-simulator-build.ts packages/tapsmith/src/__tests__/ios-simulator-build.test.ts
git commit -m "feat: add iOS simulator agent auto-build on SDK mismatch"
```

---

### Task 4: Integrate `ensureSimulatorAgent()` into the CLI

**Files:**
- Modify: `packages/tapsmith/src/cli.ts`

- [ ] **Step 1: Update the simulator xctestrun resolution in the CLI**

In `packages/tapsmith/src/cli.ts`, find the `else` block at ~line 731 that calls `findSimulatorXctestrun()` for simulators. Replace it with a call to `ensureSimulatorAgent()`:

Change from:

```typescript
    } else {
      const found = findSimulatorXctestrun();
      if (found) {
        resolvedIosXctestrun = found;
        if (progress) progress.update('agent', { state: 'pending', detail: `resolved ${path.basename(found)}` });
        else console.log(dim(`Auto-detected iOS simulator xctestrun: ${found}`));
      } else {
        progress?.fail('agent', 'no simulator xctestrun found');
        throw new Error(
          'No simulator xctestrun found under ~/Library/Developer/Xcode/DerivedData/TapsmithAgent-*. ' +
            'Build the simulator agent first (see docs/ios-physical-devices.md for the command) ' +
            'or set `iosXctestrun` explicitly.',
        );
      }
    }
```

To:

```typescript
    } else {
      const { ensureSimulatorAgent } = await import('./ios-simulator-build.js');
      try {
        const found = await ensureSimulatorAgent();
        resolvedIosXctestrun = found;
        if (progress) progress.update('agent', { state: 'pending', detail: `resolved ${path.basename(found)}` });
        else console.log(dim(`Auto-detected iOS simulator xctestrun: ${found}`));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        progress?.fail('agent', 'no simulator xctestrun found');
        throw new Error(msg);
      }
    }
```

- [ ] **Step 2: Run typecheck**

Run: `cd packages/tapsmith && npm run typecheck`
Expected: Clean

- [ ] **Step 3: Run lint**

Run: `cd packages/tapsmith && npm run lint`
Expected: Clean

- [ ] **Step 4: Commit**

```bash
git add packages/tapsmith/src/cli.ts
git commit -m "feat: use ensureSimulatorAgent() in CLI for auto-build on SDK mismatch"
```

---

### Task 5: Update doctor to report SDK version mismatch

**Files:**
- Modify: `packages/tapsmith/src/doctor.ts`

- [ ] **Step 1: Update `checkSimulatorXctestrun()`**

In `packages/tapsmith/src/doctor.ts`, replace the `checkSimulatorXctestrun` function (~lines 213–223) with:

```typescript
async function checkSimulatorXctestrun(checks: CheckList): Promise<void> {
  try {
    const { findSimulatorXctestrun, extractSdkVersion } = await import('./ios-device-resolve.js');
    const found = findSimulatorXctestrun();
    if (!found) {
      warn(checks, 'No simulator xctestrun found — build with xcodebuild or install @tapsmith/agent-ios-simulator-arm64');
      return;
    }

    const xctestrunSdk = extractSdkVersion(found);
    const sdkLabel = xctestrunSdk ? ` SDK ${xctestrunSdk}` : '';
    let installedSdk: string | undefined;
    try {
      const { getInstalledSimulatorSdkVersion } = await import('./ios-simulator-build.js');
      installedSdk = getInstalledSimulatorSdkVersion();
    } catch {
      // ios-simulator-build not available — skip comparison
    }

    if (installedSdk && xctestrunSdk && xctestrunSdk !== installedSdk) {
      warn(checks, `Simulator xctestrun built for iOS ${xctestrunSdk} but installed SDK is ${installedSdk} — will auto-build on first test run`);
    } else {
      pass(checks, `Simulator xctestrun found ${dim(`(${path.basename(found)}${sdkLabel})`)}`);
    }
  } catch {
    warn(checks, 'Could not check for simulator xctestrun');
  }
}
```

- [ ] **Step 2: Run typecheck and lint**

Run: `cd packages/tapsmith && npm run typecheck && npm run lint`
Expected: Clean

- [ ] **Step 3: Commit**

```bash
git add packages/tapsmith/src/doctor.ts
git commit -m "feat: doctor reports iOS SDK version mismatch with auto-build hint"
```

---

### Task 6: Final verification

- [ ] **Step 1: Run full SDK checks**

Run: `cd packages/tapsmith && npm run typecheck && npm run lint && npm run test && npm run knip`
Expected: All pass

- [ ] **Step 2: Run `tapsmith doctor` locally**

Run: `npx tapsmith doctor`
Expected: Simulator xctestrun check shows SDK version and/or mismatch warning

- [ ] **Step 3: Commit any remaining fixes**
