# iOS Simulator Agent Auto-Build on SDK Mismatch

## Problem

The prebuilt `@tapsmith/agent-ios-simulator-*` npm package ships an xctestrun built against a specific iOS SDK version (e.g., 18.5). When a user has a different Xcode with a different SDK (e.g., Xcode 26 with iOS 26 SDK), xcodebuild fails with exit code 65 and "Supported platforms for the buildables in the current scheme is empty." The user has no actionable fix short of cloning the monorepo and building manually.

## Solution

Detect SDK version mismatches before launching the agent and automatically build the simulator agent from bundled source when needed. Cache the build so subsequent runs are instant.

## Detection

When `findSimulatorXctestrun()` returns an xctestrun path, extract the SDK version from its filename using the regex `iphonesimulator([\d.]+)-`. Compare against the installed SDK version from `xcrun --show-sdk-version --sdk iphonesimulator`.

- **Match**: use the xctestrun as-is (fast path, no build).
- **Mismatch**: trigger auto-build.

## Auto-Build

A new `buildSimulatorAgent()` function in a new file `ios-simulator-build.ts`. This is separate from the physical-device `build-ios-agent.ts` command because simulator builds are much simpler (no code signing, no team ID, no provisioning).

```
xcodebuild build-for-testing \
  -project <agentDir>/TapsmithAgent.xcodeproj \
  -scheme TapsmithAgentUITests \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath <cacheDir>/build \
  ARCHS=arm64 ONLY_ACTIVE_ARCH=NO \
  CODE_SIGNING_ALLOWED=NO
```

Agent source is resolved using the existing `resolveIosAgentDir()` from `build-ios-agent.ts`. It already handles monorepo detection and npm-to-`~/.tapsmith/ios-agent/` extraction with version-gated cache refresh.

## Cache

Location: `~/.tapsmith/ios-simulator-agent/`.

After a successful build, copy the xctestrun file and `Debug-iphonesimulator/` bundle from the DerivedData build output into this cache directory. Write a `.sdk-version` file containing the SDK version string (e.g., `26.0`).

On subsequent runs, if `~/.tapsmith/ios-simulator-agent/.sdk-version` matches the installed SDK, use the cached xctestrun directly — no build needed.

## Resolution Order

Update `findSimulatorXctestrun()` to check the auto-build cache first:

1. **Auto-build cache** — `~/.tapsmith/ios-simulator-agent/*.xctestrun` (SDK-matched local build)
2. **npm package** — `@tapsmith/agent-ios-simulator-{arch}` (prebuilt, may not match SDK)
3. **DerivedData** — `~/Library/Developer/Xcode/DerivedData/TapsmithAgent-*` (manual local builds)

The npm package still works as a fast path when the user's Xcode SDK matches the prebuilt SDK — the cache directory won't exist, and resolution falls through to step 2.

## SDK Mismatch Check Integration

Add a new function `ensureSimulatorAgent()` that wraps the detection + build logic. Called from the CLI before passing the xctestrun path to the daemon:

1. Call `findSimulatorXctestrun()` to get an xctestrun path.
2. If none found, error as before.
3. Extract SDK version from the xctestrun filename.
4. Get installed SDK version via `xcrun --show-sdk-version --sdk iphonesimulator`.
5. If versions match, return the xctestrun path.
6. If mismatch, call `buildSimulatorAgent()` and return the newly built xctestrun path.

## UX

During auto-build, print: `Building iOS agent for SDK <version>... (cached for future runs)`.

The build takes ~30 seconds. Subsequent runs with the same SDK are instant (cache hit). When the user upgrades Xcode, the next run rebuilds automatically.

## Doctor Update

The doctor's simulator xctestrun check should:
- Report which SDK version the resolved xctestrun targets (parsed from filename).
- Compare against the installed SDK version.
- Warn if they differ: `Simulator xctestrun built for iOS <X> but installed SDK is <Y> — will auto-build on first test run`.

## Error Handling

- If `xcodebuild` is not installed or fails during auto-build, surface the error clearly and suggest `xcode-select --install`.
- If `resolveIosAgentDir()` can't find the agent source (neither monorepo nor bundled), error with a message pointing to `npm install tapsmith` or monorepo setup.
- If `xcrun --show-sdk-version` fails, skip the mismatch check and use the xctestrun as-is (let xcodebuild fail with its own error if there's a real problem).

## Files

- **Create**: `packages/tapsmith/src/ios-simulator-build.ts` — `buildSimulatorAgent()`, `getInstalledSimulatorSdkVersion()`, `ensureSimulatorAgent()`
- **Modify**: `packages/tapsmith/src/ios-device-resolve.ts` — update `findSimulatorXctestrun()` resolution order to check cache first; add `extractSdkVersion()` helper
- **Modify**: `packages/tapsmith/src/doctor.ts` — add SDK version comparison to simulator xctestrun check
- **Modify**: `packages/tapsmith/src/cli.ts` — call `ensureSimulatorAgent()` instead of raw `findSimulatorXctestrun()` before launching
- **Reuse**: `packages/tapsmith/src/build-ios-agent.ts` — import `resolveIosAgentDir()` (no changes to this file)
