# Multi-SDK iOS Simulator Agent Packages

## Problem

The `@tapsmith/agent-ios-simulator-*` packages are built against a single Xcode SDK version. Users on a different Xcode version hit "Supported platforms for the buildables in the current scheme is empty" and fall through to auto-build (~30s). In CI — where there's no persistent cache — this penalty hits every run.

## Solution

Build the iOS simulator agent on the last two GitHub Actions macOS versions (currently `macos-latest` and `macos-26`), and ship both sets of artifacts in the same npm package. The resolver picks the xctestrun matching the installed SDK. Auto-build remains as the fallback for SDKs we don't ship.

## Package Structure

Each `@tapsmith/agent-ios-simulator-*` package ships SDK-versioned subdirectories:

```
@tapsmith/agent-ios-simulator-arm64/
  package.json
  sdk-18.5/
    TapsmithAgentUITests_…_iphonesimulator18.5-arm64.xctestrun
    Debug-iphonesimulator/
  sdk-26.0/
    TapsmithAgentUITests_…_iphonesimulator26.0-arm64.xctestrun
    Debug-iphonesimulator/
```

Each subdirectory is self-contained: the xctestrun references `__TAPSMITH_PKG__/Debug-iphonesimulator/…` and the daemon's `patch_xctestrun()` replaces `__TAPSMITH_PKG__` with the directory containing the xctestrun. Since the xctestrun and its `Debug-iphonesimulator/` are siblings, paths resolve correctly.

## CI Matrix Change

The `build-ios-simulator-agent` job currently has a 2-entry matrix (arm64, x86_64) on `macos-26`. Expand to 4 entries: 2 arches x 2 macOS versions. Each variant uploads its own artifact.

The staging step writes to an SDK-versioned subdirectory instead of the package root:

```yaml
STAGING="../npm-packages/${{ matrix.npm-pkg }}/sdk-$SDK_VERSION"
```

where `SDK_VERSION` comes from `xcrun --show-sdk-version --sdk iphonesimulator`.

## Resolver Change

Update `findSimulatorXctestrun()` step 2 (npm package check) to be SDK-aware:

1. Get installed SDK version via `getInstalledSimulatorSdkVersion()`.
2. Check `pkgDir/sdk-{installedSdk}/*.xctestrun` — exact match (fast path).
3. If no exact match, scan all `pkgDir/sdk-*/*.xctestrun` and pick the newest.
4. Fall back to `pkgDir/*.xctestrun` for backward compatibility with older published packages.

If the selected xctestrun's SDK doesn't match the installed SDK, `ensureSimulatorAgent()` will auto-build as before.

## Package.json Update

Update `files` in each `agent-ios-simulator-*` package to include the subdirectories:

```json
{
  "files": [
    "sdk-*/"
  ]
}
```

Remove the old top-level patterns (`*.xctestrun`, `Debug-iphonesimulator/`).

## Backward Compatibility

The resolver checks `pkgDir/*.xctestrun` (flat layout) as a fallback. Users on older versions of the package (before this change) continue to work — they just have a single xctestrun at the package root like today.

## Files

- **Modify**: `.github/workflows/release.yml` — expand build matrix, SDK-versioned staging
- **Modify**: `packages/tapsmith/src/ios-device-resolve.ts` — SDK-aware npm package resolution
- **Modify**: `npm-packages/agent-ios-simulator-arm64/package.json` — update `files`
- **Modify**: `npm-packages/agent-ios-simulator-x64/package.json` — update `files`
