# Multi-SDK iOS Simulator Agent Packages — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship iOS simulator agent packages with xctestrun files for two SDK versions (from the last two GitHub Actions macOS versions), so most users get an instant match without auto-build.

**Architecture:** The CI matrix expands from 2 to 4 entries (2 arches x 2 macOS versions). Build artifacts go into `sdk-{version}/` subdirectories within each npm package. The resolver is updated to prefer the SDK-matched subdirectory, with fallbacks to other subdirectories, flat layout (backward compat), and auto-build.

**Tech Stack:** GitHub Actions, TypeScript, Vitest

---

### Task 1: Move `getInstalledSimulatorSdkVersion()` to `ios-device-resolve.ts`

The resolver needs to know the installed SDK to pick the right subdirectory. Currently `getInstalledSimulatorSdkVersion()` lives in `ios-simulator-build.ts`, but importing it from there would create a circular dependency (`ios-simulator-build.ts` already imports from `ios-device-resolve.ts`). Move it to where it's needed.

**Files:**
- Modify: `packages/tapsmith/src/ios-device-resolve.ts`
- Modify: `packages/tapsmith/src/ios-simulator-build.ts`

- [ ] **Step 1: Add `getInstalledSimulatorSdkVersion()` to `ios-device-resolve.ts`**

Add this import to the top of `packages/tapsmith/src/ios-device-resolve.ts`:

```typescript
import { execFileSync } from 'node:child_process';
```

Add this function (can go right after `extractSdkVersion`):

```typescript
export function getInstalledSimulatorSdkVersion(): string | undefined {
  try {
    const raw = execFileSync(
      'xcrun',
      ['--show-sdk-version', '--sdk', 'iphonesimulator'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return raw.trim() || undefined;
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 2: Update `ios-simulator-build.ts` to import from `ios-device-resolve.ts`**

In `packages/tapsmith/src/ios-simulator-build.ts`:

Remove the `execFileSync` import from `node:child_process` (keep `execFile` if it's still used).

Remove the `getInstalledSimulatorSdkVersion()` function body.

Update the import from `ios-device-resolve.js` to include it:

```typescript
import { extractSdkVersion, findSimulatorXctestrun, getInstalledSimulatorSdkVersion } from './ios-device-resolve.js';
```

Remove `execFileSync` from the `node:child_process` import (keep `execFile`):

```typescript
import { execFile } from 'node:child_process';
```

- [ ] **Step 3: Update `doctor.ts` import**

In `packages/tapsmith/src/doctor.ts`, the `checkSimulatorXctestrun` function imports `getInstalledSimulatorSdkVersion` from `ios-simulator-build.js`. Update it to import from `ios-device-resolve.js` instead:

Change:
```typescript
      const { getInstalledSimulatorSdkVersion } = await import('./ios-simulator-build.js');
```
To:
```typescript
      const { getInstalledSimulatorSdkVersion } = await import('./ios-device-resolve.js');
```

(It's already dynamically imported in the same try block, so just merge with the existing `ios-device-resolve.js` import.)

Actually, simpler: merge into the existing import at the top of that function:

```typescript
    const { findSimulatorXctestrun, extractSdkVersion, getInstalledSimulatorSdkVersion } = await import('./ios-device-resolve.js');
```

And remove the separate `import('./ios-simulator-build.js')` call and its try/catch wrapper.

- [ ] **Step 4: Run typecheck and tests**

Run: `cd packages/tapsmith && npm run typecheck && npm run test`
Expected: Clean pass — this is a pure refactor, no behavior change.

- [ ] **Step 5: Commit**

```bash
git add packages/tapsmith/src/ios-device-resolve.ts packages/tapsmith/src/ios-simulator-build.ts packages/tapsmith/src/doctor.ts
git commit -m "refactor: move getInstalledSimulatorSdkVersion to ios-device-resolve"
```

---

### Task 2: Make `findSimulatorXctestrun()` SDK-aware for npm packages

Update the npm package resolution step to check SDK-versioned subdirectories.

**Files:**
- Modify: `packages/tapsmith/src/ios-device-resolve.ts`
- Modify: `packages/tapsmith/src/__tests__/ios-simulator-build.test.ts`

- [ ] **Step 1: Write tests for SDK-aware resolution**

Add to `packages/tapsmith/src/__tests__/ios-simulator-build.test.ts`:

```typescript
describe('findSimulatorXctestrun() SDK-aware resolution', () => {
  beforeEach(() => {
    vi.resetModules();
    existsSync.mockReset();
    readdirSync.mockReset();
    statSync.mockReset();
    mockResolve.mockReset();
    execFileSyncMock.mockReset();
    homedir.mockReturnValue('/Users/test');
  });

  it('prefers exact SDK match from npm package subdirectory', async () => {
    // xcrun returns SDK 26.0
    execFileSyncMock.mockReturnValue('26.0\n');

    // npm package is installed
    mockResolve.mockReturnValue('/node_modules/@tapsmith/agent-ios-simulator-arm64/package.json');

    const sdk26Dir = '/node_modules/@tapsmith/agent-ios-simulator-arm64/sdk-26.0';
    const xctestrun26 = 'TapsmithAgentUITests_iphonesimulator26.0-arm64.xctestrun';

    readdirSync.mockImplementation((dir) => {
      const d = String(dir);
      if (d.endsWith('ios-simulator-agent')) throw new Error('ENOENT'); // no cache
      if (d === '/node_modules/@tapsmith/agent-ios-simulator-arm64') return ['sdk-18.5', 'sdk-26.0'] as unknown as fs.Dirent[];
      if (d === sdk26Dir) return [xctestrun26] as unknown as fs.Dirent[];
      throw new Error('ENOENT');
    });
    existsSync.mockImplementation((p) => String(p) === sdk26Dir);
    statSync.mockReturnValue({ mtimeMs: Date.now() } as fs.Stats);

    const { findSimulatorXctestrun } = await import('../ios-device-resolve.js');
    const result = findSimulatorXctestrun();
    expect(result).toBe(path.join(sdk26Dir, xctestrun26));
  });

  it('falls back to flat layout for backward compat with old packages', async () => {
    execFileSyncMock.mockReturnValue('18.5\n');
    mockResolve.mockReturnValue('/node_modules/@tapsmith/agent-ios-simulator-arm64/package.json');

    const pkgDir = '/node_modules/@tapsmith/agent-ios-simulator-arm64';
    const xctestrun = 'TapsmithAgentUITests_iphonesimulator18.5-arm64.xctestrun';

    readdirSync.mockImplementation((dir) => {
      const d = String(dir);
      if (d.endsWith('ios-simulator-agent')) throw new Error('ENOENT');
      // No sdk-* subdirectories — flat layout
      if (d === pkgDir) return [xctestrun, 'Debug-iphonesimulator'] as unknown as fs.Dirent[];
      throw new Error('ENOENT');
    });
    existsSync.mockReturnValue(false); // no sdk-18.5 subdir
    statSync.mockReturnValue({ mtimeMs: Date.now() } as fs.Stats);

    const { findSimulatorXctestrun } = await import('../ios-device-resolve.js');
    const result = findSimulatorXctestrun();
    expect(result).toBe(path.join(pkgDir, xctestrun));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/tapsmith && npx vitest run src/__tests__/ios-simulator-build.test.ts`
Expected: FAIL — the SDK-aware resolution doesn't exist yet.

- [ ] **Step 3: Update `findSimulatorXctestrun()` npm package step**

Replace step 2 in `findSimulatorXctestrun()` (the npm package resolution block, lines ~128–138 of `ios-device-resolve.ts`) with:

```typescript
  // 2. Try the prebuilt npm package for the current architecture.
  const arch = process.arch;
  const pkg = `@tapsmith/agent-ios-simulator-${arch}`;
  try {
    const pkgJsonPath = require.resolve(`${pkg}/package.json`);
    const pkgDir = path.dirname(pkgJsonPath);
    const installedSdk = getInstalledSimulatorSdkVersion();

    // 2a. Exact SDK match in sdk-{version}/ subdirectory.
    if (installedSdk) {
      const sdkSubdir = path.join(pkgDir, `sdk-${installedSdk}`);
      if (fs.existsSync(sdkSubdir)) {
        const match = newestSimulatorXctestrunIn(sdkSubdir);
        if (match) return match;
      }
    }

    // 2b. Any sdk-*/ subdirectory (newest xctestrun wins).
    try {
      const subdirs = fs.readdirSync(pkgDir)
        .filter((e) => e.startsWith('sdk-'))
        .map((e) => path.join(pkgDir, e));
      for (const subdir of subdirs) {
        const match = newestSimulatorXctestrunIn(subdir);
        if (match) return match;
      }
    } catch {
      // No subdirectories — fall through.
    }

    // 2c. Flat layout (backward compat with older packages).
    const flat = newestSimulatorXctestrunIn(pkgDir);
    if (flat) return flat;
  } catch {
    // Package not installed — fall through.
  }
```

- [ ] **Step 4: Run tests**

Run: `cd packages/tapsmith && npx vitest run src/__tests__/ios-simulator-build.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Run typecheck**

Run: `cd packages/tapsmith && npm run typecheck`
Expected: Clean.

- [ ] **Step 6: Commit**

```bash
git add packages/tapsmith/src/ios-device-resolve.ts packages/tapsmith/src/__tests__/ios-simulator-build.test.ts
git commit -m "feat: SDK-aware xctestrun resolution from npm package subdirectories"
```

---

### Task 3: Update npm package `files` fields

**Files:**
- Modify: `npm-packages/agent-ios-simulator-arm64/package.json`
- Modify: `npm-packages/agent-ios-simulator-x64/package.json`

- [ ] **Step 1: Update arm64 package.json**

Replace the `files` array in `npm-packages/agent-ios-simulator-arm64/package.json`:

```json
{
  "files": [
    "sdk-*/",
    "*.xctestrun",
    "Debug-iphonesimulator/"
  ]
}
```

We keep the old patterns (`*.xctestrun`, `Debug-iphonesimulator/`) so the same package.json works with both the old (flat) and new (sdk-*/) staging layouts during the transition.

- [ ] **Step 2: Update x64 package.json**

Same change in `npm-packages/agent-ios-simulator-x64/package.json`:

```json
{
  "files": [
    "sdk-*/",
    "*.xctestrun",
    "Debug-iphonesimulator/"
  ]
}
```

- [ ] **Step 3: Commit**

```bash
git add npm-packages/agent-ios-simulator-arm64/package.json npm-packages/agent-ios-simulator-x64/package.json
git commit -m "feat: update iOS agent package files to include sdk-*/ subdirectories"
```

---

### Task 4: Expand CI build matrix and update staging

**Files:**
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: Expand the build matrix**

Replace the `build-ios-simulator-agent` job's matrix and runner config (lines ~146–196 of `release.yml`). The matrix now has 4 entries — 2 arches x 2 macOS versions:

```yaml
  # ─── Build iOS simulator agent for arm64 and x64 ───
  build-ios-simulator-agent:
    name: Build iOS simulator agent (${{ matrix.arch }}, ${{ matrix.os }})
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        include:
          - arch: arm64
            os: macos-latest
            npm-pkg: agent-ios-simulator-arm64
          - arch: arm64
            os: macos-26
            npm-pkg: agent-ios-simulator-arm64
          - arch: x86_64
            os: macos-latest
            npm-pkg: agent-ios-simulator-x64
          - arch: x86_64
            os: macos-26
            npm-pkg: agent-ios-simulator-x64
    defaults:
      run:
        working-directory: ios-agent
    steps:
      - uses: actions/checkout@v4

      - name: Build for testing
        run: |
          xcodebuild build-for-testing \
            -project TapsmithAgent.xcodeproj \
            -scheme TapsmithAgentUITests \
            -destination 'generic/platform=iOS Simulator' \
            -derivedDataPath '.build-sim-${{ matrix.arch }}' \
            ARCHS='${{ matrix.arch }}' ONLY_ACTIVE_ARCH=NO \
            CODE_SIGNING_ALLOWED=NO

      - name: Stage package contents
        run: |
          PRODUCTS=".build-sim-${{ matrix.arch }}/Build/Products"
          PRODUCTS_ABS="$(cd "$PRODUCTS" && pwd)"
          SDK_VERSION="$(xcrun --show-sdk-version --sdk iphonesimulator)"
          STAGING="../npm-packages/${{ matrix.npm-pkg }}/sdk-${SDK_VERSION}"
          mkdir -p "$STAGING"

          # Copy xctestrun file(s) and the test runner app bundle
          cp "$PRODUCTS"/*iphonesimulator*.xctestrun "$STAGING/"
          cp -R "$PRODUCTS/Debug-iphonesimulator" "$STAGING/"

          # Replace absolute DerivedData paths with __TAPSMITH_PKG__ placeholder
          for f in "$STAGING"/*.xctestrun; do
            plutil -convert xml1 "$f"
            sed -i '' "s|${PRODUCTS_ABS}|__TAPSMITH_PKG__|g" "$f"
          done

      - name: Upload artifact
        uses: actions/upload-artifact@v4
        with:
          name: ios-sim-agent-${{ matrix.npm-pkg }}-${{ matrix.os }}
          path: |
            npm-packages/${{ matrix.npm-pkg }}/sdk-*/
```

Key changes:
- Matrix adds `os` dimension (`macos-latest`, `macos-26`)
- Staging writes to `sdk-${SDK_VERSION}/` subdirectory instead of package root
- Artifact name includes `${{ matrix.os }}` to avoid collisions between the two macOS versions for the same arch

- [ ] **Step 2: Update the publish job to download all artifacts**

In the `publish-ios-simulator-packages` job, the download step currently downloads one artifact per package. Now there are two artifacts per package (one per macOS version). Replace the single download step with two:

```yaml
      - name: Download iOS simulator agent (macos-latest)
        uses: actions/download-artifact@v4
        with:
          name: ios-sim-agent-${{ matrix.pkg }}-macos-latest
          path: npm-packages/${{ matrix.pkg }}/

      - name: Download iOS simulator agent (macos-26)
        uses: actions/download-artifact@v4
        with:
          name: ios-sim-agent-${{ matrix.pkg }}-macos-26
          path: npm-packages/${{ matrix.pkg }}/
```

Both download into the same directory — since they use different `sdk-{version}/` subdirectories, there's no collision.

- [ ] **Step 3: Verify YAML structure**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml'))" 2>/dev/null || python3 -c "
with open('.github/workflows/release.yml') as f:
    content = f.read()
assert 'macos-latest' in content
assert 'macos-26' in content
assert 'sdk-' in content
assert 'ios-sim-agent-' in content
print('YAML structure checks passed')
"`

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: build iOS simulator agent on two macOS versions for multi-SDK packages"
```

---

### Task 5: Final verification

- [ ] **Step 1: Run full SDK checks**

Run: `cd packages/tapsmith && npm run typecheck && npm run lint && npm run test && npm run knip`
Expected: All pass.

- [ ] **Step 2: Verify the complete resolution flow makes sense**

Check that `findSimulatorXctestrun()` resolution order is:
1. Auto-build cache (`~/.tapsmith/ios-simulator-agent/`)
2. npm package exact SDK match (`sdk-{installedSdk}/`)
3. npm package any SDK subdirectory (`sdk-*/`)
4. npm package flat layout (backward compat)
5. DerivedData scan

Run: `grep -A 30 'findSimulatorXctestrun' packages/tapsmith/src/ios-device-resolve.ts | head -40`

- [ ] **Step 3: Commit any remaining fixes**
