# iOS physical devices

Pilot supports running tests against real iPhones and iPads over USB. This page covers the basic setup — everything you need to run tests on a real device. If you also want decrypted HTTPS capture in your traces, head to [iOS physical device network capture](./ios-physical-device-network-tracing.md) after finishing this page.

Simulators are easier (nothing to sign, nothing to install). Use simulators for fast iteration and physical devices when you specifically need to validate hardware-dependent behavior (camera, NFC, biometrics, signed receipts, real carrier network, battery, etc.).

## Prerequisites

- macOS with Xcode 15 or later
- An Apple Developer account (free accounts work; note the 7-day profile expiry caveat below)
- `libimobiledevice` (`brew install libimobiledevice`)
- A physical iOS device paired with this Mac

Run the preflight — it verifies each of these and prints the exact command to fix anything missing:

```sh
pilot setup-ios-device
```

## One-time setup

1. **Plug the device in** via USB.

2. **Trust the Mac from the device.** When the "Trust This Computer?" dialog appears on the phone, tap **Trust** and enter your passcode.

3. **Enable Developer Mode on the device.** Settings → Privacy & Security → Developer Mode → **On**. The device will reboot.

4. **Register the device with your Apple Developer team.** Open Xcode → Window → Devices and Simulators, wait for the device to appear, and click **Use for Development**. Xcode auto-creates the development provisioning profile. This is the one step that can't be automated from the command line — Xcode owns device registration.

5. **Verify with `pilot setup-ios-device`.** Every row should be ✓ and your device should be listed as "ready for pilot test". If it says "not paired", go back through steps 1-4.

6. **Build the signed Pilot agent for your device.**

   ```sh
   pilot build-ios-agent
   ```

   This auto-detects the Apple Developer team from Xcode's Accounts preferences, runs `xcodebuild build-for-testing` with automatic signing, and caches the resulting `.xctestrun` under `ios-agent/.build-device/`. First run takes 60–120s; incremental rebuilds are <10s. If you have multiple teams, pass `--team-id XXXXXXXXXX` to skip the prompt.

   Rebuild when you upgrade Pilot, switch teams/devices, or your profile expires. **Free Apple Developer accounts expire provisioning profiles every 7 days** — Pilot will warn you when you're within three days of expiry.

7. **Run your first test.** The first run installs the Pilot runner on the device and will fail with *"Developer App Certificate is not trusted"*. That's expected — it's the cue for the next step.

   ```sh
   pilot test --config <your-config>
   ```

8. **Trust the developer certificate on the device.** Settings → General → VPN & Device Management → **Apple Development: _Your Name_** → **Trust**. You only need to do this once per (device, Apple Developer team) pair. Paid accounts often skip this entirely — Xcode auto-trusts at registration time. Free accounts need to re-trust each time the 7-day profile rolls.

9. **Disable Auto-Lock while testing.** Settings → Display & Brightness → Auto-Lock → **Never**. XCUITest can't interact with a locked screen. Restore your usual setting after the session.

10. **Re-run `pilot test`.** From now on, installs and launches are automatic.

On every subsequent run, Pilot checks whether the dev cert is still trusted *before* launching the test suite. If trust has rolled (free account expiry, cert rotation), you get an immediate, actionable error with the Settings path — no more 60-second mid-test hangs.

## Running tests

Pilot auto-detects both the UDID and the xctestrun for physical devices, so a minimal config is just `platform: 'ios'` + `app` + `package`:

```ts
import { defineConfig } from 'pilot';

export default defineConfig({
  platform: 'ios',
  app: './build/MyApp-Device.app',   // device-signed build of your app
  package: 'com.example.myapp',
});
```

What Pilot fills in for you:

- **Device UDID** — when `device` is omitted, Pilot picks the single paired USB iOS device. Zero or more than one → actionable error.
- **`iosXctestrun`** — when omitted, Pilot looks under `ios-agent/.build-device/Build/Products/` for the newest `*iphoneos*.xctestrun` (populated by `pilot build-ios-agent`).

Both can be overridden:

```ts
export default defineConfig({
  platform: 'ios',
  app: './build/MyApp-Device.app',
  package: 'com.example.myapp',
  device: '00008140-00096C9014F3001C',
  iosXctestrun: 'ios-agent/.build-device/Build/Products/PilotAgentUITests_PilotAgentUITests_iphoneos26.4-arm64.xctestrun',
});
```

### Running simulator and device together

Use projects to target both from a single `pilot test` invocation:

```ts
export default defineConfig({
  projects: [
    {
      name: 'ios-sim',
      use: {
        platform: 'ios',
        simulator: 'iPhone 16',
        app: './build/MyApp.app',
        package: 'com.example.myapp',
      },
    },
    {
      name: 'ios-phys',
      use: {
        platform: 'ios',
        app: './build/MyApp-Device.app',
        package: 'com.example.myapp',
        // device + iosXctestrun auto-detected
      },
    },
  ],
});
```

```sh
pilot test                    # runs both projects
pilot test --project ios-phys # just the physical device
```

| Field | Simulator | Physical device |
|---|---|---|
| `simulator` | Name or UDID | — |
| `device` | — | Auto-detected (or UDID override) |
| `iosXctestrun` | Simulator-slice xctestrun | Auto-detected under `ios-agent/.build-device/` |
| `app` | Simulator-slice `.app` | Device-signed `.app` |

## Want network capture too?

If you need decrypted HTTPS request/response bodies in your traces, set up [iOS physical device network capture](./ios-physical-device-network-tracing.md). It's a separate one-time step per device involving a mobileconfig profile and a MITM CA trust — nothing you need for basic testing.

## Known limitations

Some simulator-only APIs don't work on physical devices and will return a clear `UNSUPPORTED_ON_PHYSICAL_DEVICE` error at test time:

- `device.clearAppData(...)` — physical devices don't expose their app container filesystem to the host. Use `--force-install` to reinstall the bundle instead.
- `device.setClipboard(...)` / `device.getClipboard(...)` — blocked by the iOS 16+ paste permission dialog. Seed/read the clipboard from within your app via a test-only debug hook.
- `device.openDeepLink(...)` — no `devicectl` equivalent of `simctl openurl`. Add a test-only button that calls `UIApplication.shared.open(url)`.
- `device.setColorScheme(...)` — simulator-only. Set light/dark mode manually.
- `device.grantPermission(...)` / `device.revokePermission(...)` — simulator-only. Let the XCUITest UIInterruptionMonitor tap through the in-app dialogs.
- `device.saveAppState(...)` / `device.restoreAppState(...)` — simulator-only. Use simulator-based setup projects for reusable auth state.

Other caveats:

- **Slow test resets.** Physical devices don't have the simctl fast-path for `restartApp`. Instead the agent does a full XCUITest relaunch (~8s per reset).
- **Only one test run per physical device at a time.** The dispatcher already assigns one device per worker.

## Troubleshooting

Run `pilot setup-ios-device` first — it surfaces most setup issues with actionable fix instructions. Common failure modes:

**"No Account for Team 'XXXXXXXXXX'"** — Xcode doesn't have the Apple ID that owns that team signed in. Open Xcode → Settings → Accounts and sign in.

**"No profiles for 'dev.pilot.agent.xctrunner' were found"** — Your device isn't registered under the selected team. Open Xcode → Window → Devices and Simulators and wait for auto-registration.

**"Developer Mode disabled"** — Settings → Privacy & Security → Developer Mode → On, then reboot.

**"Unable to install PilotAgentUITests-Runner"** — the developer profile isn't trusted on the device. Settings → General → VPN & Device Management → trust it.

**"iproxy not found"** — `brew install libimobiledevice`.

**`Password:` prompt mid-test, right after "Starting iOS agent…"** — Xcode 26's CoreDevice calls `sudo -- /usr/bin/true` before mounting the Developer Disk Image. Pilot itself doesn't call sudo. Eliminate the prompt permanently by allowing that single binary without a password:

```sh
echo "$USER ALL=(ALL) NOPASSWD: /usr/bin/true" | sudo tee /etc/sudoers.d/zz-pilot-xcode-ddi
sudo chmod 440 /etc/sudoers.d/zz-pilot-xcode-ddi
```

`/usr/bin/true` is a literal no-op (exit 0, no side effects), so scoping NOPASSWD to it is safe. The `zz-` prefix is important: sudoers uses last-match-wins rule resolution, so without it a user-specific file like `/etc/sudoers.d/<username>` can silently override the Pilot grant. `pilot setup-ios-device` detects this exact failure mode and tells you so directly.

**"Device unpaired" in `pilot setup-ios-device`** — Xcode → Window → Devices and Simulators → "Use for Development".
