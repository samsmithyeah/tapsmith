# CI Setup

This guide covers running Pilot tests in continuous integration environments. The key challenge is setting up enough Android emulator capacity in a headless environment.

## Overview

To run Pilot tests in CI, you need:

1. An Android emulator running in headless mode (no GPU/display required).
2. ADB available on the PATH.
3. Node.js 18+ installed.
4. The Pilot daemon binary (installed automatically with `npm install pilot`).

## GitHub Actions

Here is a complete GitHub Actions workflow that builds your app, starts an emulator, and runs Pilot tests.

```yaml
name: Mobile Tests

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 30

    steps:
      - uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"

      - name: Install dependencies
        run: npm ci

      - name: Set up JDK
        uses: actions/setup-java@v4
        with:
          distribution: "temurin"
          java-version: "17"

      - name: Build APK
        run: ./gradlew assembleDebug

      - name: Enable KVM
        run: |
          echo 'KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"' | sudo tee /etc/udev/rules.d/99-kvm4all.rules
          sudo udevadm control --reload-rules
          sudo udevadm trigger --name-match=kvm

      - name: Start emulator
        uses: reactivecircus/android-emulator-runner@v2
        with:
          api-level: 33
          arch: x86_64
          emulator-options: -no-window -gpu swiftshader_indirect -no-snapshot -noaudio -no-boot-anim
          script: npx pilot test

      - name: Upload test artifacts
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: pilot-results
          path: pilot-results/
          retention-days: 14
```

### Key Points

- **KVM acceleration** is required for acceptable emulator performance on Linux CI runners. The `Enable KVM` step configures this.
- The `android-emulator-runner` action handles downloading the system image, creating the AVD, and starting the emulator. Your test command runs in the `script` parameter after the emulator boots.
- The `if: always()` on the upload step ensures screenshots are uploaded even when tests fail.

## General CI Tips

### Emulator Startup

Android emulators can take 1-3 minutes to boot in CI. Make sure your CI timeout accounts for this. The `android-emulator-runner` action waits for the emulator to finish booting before running your script.

If you are managing the emulator yourself:

```bash
# Create an AVD
avdmanager create avd -n test -k "system-images;android-33;google_apis;x86_64" --force

# Start the emulator in the background
emulator -avd test -no-window -gpu swiftshader_indirect -no-snapshot -noaudio -no-boot-anim &

# Wait for the device to boot completely
adb wait-for-device
adb shell 'while [[ -z $(getprop sys.boot_completed) ]]; do sleep 1; done'

# Run tests
npx pilot test
```

### ADB Setup

Most CI images with Android tooling already have ADB on the PATH. If yours does not:

```bash
export ANDROID_HOME=$HOME/android-sdk
export PATH=$PATH:$ANDROID_HOME/platform-tools
```

Verify ADB is working before running tests:

```bash
adb devices
# Should list your emulator, e.g.:
# emulator-5554   device
```

### Timeouts

CI emulators are slower than local machines. Increase the default timeout in your CI config:

```typescript
// pilot.config.ts
import { defineConfig } from "pilot";

export default defineConfig({
  apk: "./app-debug.apk",
  timeout: 60_000, // 60 seconds for CI
  retries: 2, // Retry flaky tests
});
```

Or use a separate config for CI by checking an environment variable:

```typescript
import { defineConfig } from "pilot";

const isCI = process.env.CI === "true";

export default defineConfig({
  apk: "./app-debug.apk",
  timeout: isCI ? 60_000 : 30_000,
  retries: isCI ? 2 : 0,
  screenshot: isCI ? "always" : "only-on-failure",
});
```

### Screenshot Artifacts

Set the `screenshot` option to `"always"` in CI to capture screenshots for every test. This makes debugging failures much easier when you cannot see the emulator screen.

Screenshots are saved to `<outputDir>/screenshots/` (by default `pilot-results/screenshots/`). Upload this directory as a CI artifact so you can download and inspect screenshots after a run.

Each screenshot file is named with the test name and a timestamp:

```
pilot-results/screenshots/
  user_can_log_in-1710345600000.png
  shows_error_on_invalid_credentials-1710345601234.png
```

### Caching

Cache the Android SDK and emulator system images to speed up CI runs:

```yaml
- name: Cache Android SDK
  uses: actions/cache@v4
  with:
    path: |
      ~/.android/avd
      ~/android-sdk
    key: android-sdk-${{ runner.os }}-api33
```

### Parallel Workers

Pilot can run multiple workers in parallel as long as each worker has its own
device or emulator instance. The recommended emulator-managed setup is:

```typescript
import { defineConfig } from "pilot";

export default defineConfig({
  apk: "./app-debug.apk",
  package: "com.example.myapp",
  workers: 4,
  launchEmulators: true,
  avd: "Pixel_9_API_35",
  timeout: 60_000,
});
```

With that config, `npx pilot test` will try to launch repeated instances of the
same AVD for all workers.

### CI Sharding

If your CI environment cannot support multiple emulator instances on one host,
split the suite across multiple jobs instead. Use `--shard=x/y` to
deterministically assign test files to each job:

```yaml
strategy:
  matrix:
    shard: [1, 2, 3]

steps:
  # ... setup steps ...
  - name: Run tests (shard ${{ matrix.shard }}/3)
    run: npx pilot test --shard=${{ matrix.shard }}/3

  - name: Upload blob report
    if: always()
    uses: actions/upload-artifact@v4
    with:
      name: blob-report-${{ matrix.shard }}
      path: blob-report/
```

When `--shard` is used, Pilot automatically adds the `blob` reporter so results
can be merged after all shards complete.

### Merging Sharded Reports

After all shard jobs finish, download the blob artifacts and merge them into a
single HTML report:

```yaml
merge-reports:
  needs: test
  runs-on: ubuntu-latest
  if: always()
  steps:
    - uses: actions/checkout@v4

    - name: Download blob reports
      uses: actions/download-artifact@v4
      with:
        pattern: blob-report-*
        path: all-blob-reports
        merge-multiple: true

    - name: Merge reports
      run: npx pilot merge-reports all-blob-reports

    - name: Upload HTML report
      uses: actions/upload-artifact@v4
      with:
        name: pilot-report
        path: pilot-report/
```
