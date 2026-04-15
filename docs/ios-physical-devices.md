# iOS physical devices

Pilot supports running tests against real iPhones and iPads via USB. This page walks through the one-time setup and daily workflow.

Simulators are easier (nothing to sign, no mobileconfig, no tunnels). Use simulators for fast iteration and physical devices when you specifically need to validate hardware-dependent behavior (camera, NFC, biometrics, signed receipts, real carrier network, battery, etc.).

## Prerequisites

- macOS with Xcode 15 or later
- An Apple Developer account (free accounts work; note the 7-day profile expiry caveat below)
- `libimobiledevice` (`brew install libimobiledevice`)
- A physical iOS device paired with this Mac

The preflight command verifies each of these and tells you exactly what to fix if one is missing:

```sh
pilot setup-ios-device
```

## One-time setup

1. **Plug the device in.** Use a USB cable (wireless pairing works too but is out of scope here).

2. **Trust the Mac from the device.** When the "Trust This Computer?" dialog appears on the phone, tap **Trust** and enter your passcode.

3. **Enable Developer Mode on the device.** Settings → Privacy & Security → Developer Mode → **On**. The device will reboot.

4. **Register the device with your Apple Developer team.** Open Xcode → Window → Devices and Simulators, wait for the device to appear, and click **Use for Development**. Xcode will automatically register the device under your team and download a development provisioning profile. This is the step that's impossible to automate from the command line — every other step below works headlessly, but Xcode owns the one-time device registration.

5. **Verify with `pilot setup-ios-device`.** Every row should be ✓ and your device should be listed as "ready for pilot test". If it says "not paired" or "Developer Disk Image not mounted", go back through steps 1-4. `pilot list-devices` gives a one-line view of everything Pilot can see (iOS physical, iOS simulators, Android) — handy for confirming the UDID to drop into your config.

6. **Build the signed Pilot agent for your device.**

   ```sh
   pilot build-ios-agent
   ```

   This auto-detects the Apple Developer team from Xcode's Accounts preferences, runs `xcodebuild build-for-testing` with automatic signing, and caches the resulting `.xctestrun` under `ios-agent/.build-device/`. First run takes 60–120s; incremental rebuilds are <10s.

   If you have multiple teams you'll be prompted to pick. Pass `--team-id XXXXXXXXXX` explicitly to skip the prompt in scripts.

   Rebuild when:
   - You upgrade Pilot (new agent code)
   - Your provisioning profile expires (free accounts: every 7 days)
   - You switch teams or devices

7. **Trust your Apple Developer certificate on the device.** This is an Apple platform requirement that cannot be automated from the command line. Apps signed with a development certificate must be explicitly trusted by the user before iOS will launch them.

   After the first `pilot test` run on a new device, open **Settings → General → VPN & Device Management** on the phone. Under **Developer App**, find the entry for your Apple ID — it'll appear as **Apple Development: _Your Name_**, reflecting the team `pilot build-ios-agent` picked up from your Xcode account — and tap **Trust**.

   You only need to do this **once per (device, Apple Developer team) pair**. After trusting, all subsequent Pilot test runs install and launch automatically.

   - **Paid Apple Developer Program**: trust persists indefinitely.
   - **Free accounts**: the provisioning profile expires every 7 days, so you'll need to re-run `pilot build-ios-agent` and re-trust on the device after each expiry.

   Symptom if you skip this step: tests run for a few minutes using the first CoreDevice install, then fail during a recovery reinstall with _"The application could not be launched because the Developer App Certificate is not trusted."_

8. **Disable auto-lock on the device while testing.** Settings → Display & Brightness → Auto-Lock → **Never**. XCUITest can't interact with a locked screen — tests will hang or fail to resolve elements once the phone sleeps. Re-enable auto-lock after your test session.

## Running tests

Add a project for the physical device to your `pilot.config.ts`:

```ts
import { defineConfig } from 'pilot';

export default defineConfig({
  projects: [
    {
      name: 'ios-sim',
      use: {
        platform: 'ios',
        simulator: 'iPhone 16',
        iosXctestrun: 'ios-agent/.build-sim/…/PilotAgent.xctestrun',
        app: './build/MyApp.app',
        package: 'com.example.myapp',
      },
    },
    {
      name: 'ios-phys',
      use: {
        platform: 'ios',
        device: '00008140-00096C9014F3001C',  // device UDID from `pilot setup-ios-device`
        iosXctestrun: 'ios-agent/.build-device/Build/Products/PilotAgentUITests_PilotAgentUITests_iphoneos26.4-arm64.xctestrun',
        app: './build/MyApp-Device.app',     // device-signed build of your app
        package: 'com.example.myapp',
      },
    },
  ],
});
```

Key differences from the simulator project:

| Field | Simulator | Physical device |
|---|---|---|
| `simulator` | Name or UDID | — (use `device`) |
| `device` | — | UDID |
| `iosXctestrun` | Simulator-slice xctestrun | Device-slice xctestrun (built via `pilot build-ios-agent`) |
| `app` | Simulator-slice `.app` | Device-signed `.app` |

Then run:

```sh
pilot test                 # runs both projects
pilot test --project ios-phys    # just the physical device
```

## Network capture (optional)

If you want decrypted HTTPS request/response bodies in your traces, set up network capture per device. This is a one-time step per device + per Wi-Fi network.

First, **disable macOS Application Firewall stealth mode** if you have it on:

```sh
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setstealthmode off
```

Stealth mode silently drops inbound TCP SYNs to user processes — even binaries that are explicitly allowed in the firewall list. Without this, the iPhone on Wi-Fi can't reach the Pilot proxy on the Mac's LAN IP and `pilot test` with network capture will report zero entries. `pilot setup-ios-device` flags this with a ⚠ hint.

Next, generate the mobileconfig profile:

```sh
# Auto-detect SSID (macOS 14+ may require --ssid since Apple redacts it)
pilot configure-ios-network 00008140-00096C9014F3001C

# Or pass it explicitly (recommended on modern macOS)
pilot configure-ios-network 00008140-00096C9014F3001C --ssid "YourWiFiName"
```

The command prints a walkthrough for installing the profile on the device. In short:

1. AirDrop `~/.pilot/devices/<UDID>.mobileconfig` to the device (the CLI reveals it in Finder for you)
2. Install the profile via Settings → Profile Downloaded (or Settings → General → VPN & Device Management)
3. **After install**, trust the Pilot CA in Settings → General → About → Certificate Trust Settings (the row only appears after step 2)

Finally, verify end-to-end:

```sh
pilot verify-ios-network 00008140-00096C9014F3001C
```

This starts the proxy, asks you to load an HTTPS page in Safari on the device, then reports whether Pilot saw the traffic and was able to decrypt it. Use it before running tests — it catches the three most common failure modes (profile not installed, CA not trusted, firewall blocking) with specific fix-it hints.

From then on, `pilot test --trace on` against that UDID will capture full HTTPS traffic into the trace. See [ios-network-capture.md](./ios-network-capture.md#physical-ios-devices) for the full writeup, including the host Wi-Fi IP drift fix and parallel-device setup.

### What gets captured

**Important:** On physical iOS, the Wi-Fi HTTP proxy is applied system-wide by iOS — there's no per-app scoping available without an MDM enrollment. That means Pilot's MITM proxy sees traffic from **every app and background service running on the device**, not just the app under test:

- iOS system services (captive portal checks, weather, analytics, iCloud sync)
- Any other app you have running (Mail, Safari, Messages, etc.)
- The app under test

By default those all end up in the trace alongside your app's traffic. Two things help:

1. **Use a host allowlist** in `pilot.config.ts` to keep only the traffic that matters:

   ```ts
   trace: {
     mode: 'on',
     networkHosts: ['*.myapp.com', 'api.example.com'],
   }
   ```

   Only entries whose hostname matches one of the patterns will appear in traces. Glob syntax: `*` matches any number of characters, `*.example.com` matches `api.example.com`, `cdn.example.com`, and `example.com` itself. Case-insensitive. Omit the field to keep every entry.

2. **Close unrelated apps** on the phone before running tests — iOS background services are unavoidable but at least Mail/Safari/etc. go quiet.

On iOS **simulators** the filtering is handled automatically at the kernel level by the macOS Network Extension redirector (per-PID), so simulator runs aren't noisy. `networkHosts` is still honoured there if set, but rarely needed.

### Why explicit `--ssid` is usually needed

macOS 14+ redacts Wi-Fi SSIDs from `ipconfig getsummary` output unless the calling process has Location Services permission. The legacy `networksetup -getairportnetwork` command is also broken on modern macOS (always returns "You are not associated with an AirPort network" even when connected). Pilot detects the redacted placeholder and bails with a clear error, but passing `--ssid "YourWiFiName"` explicitly avoids the dance entirely.

## Known limitations

Some simulator-only APIs don't work on physical devices and will return a clear `UNSUPPORTED_ON_PHYSICAL_DEVICE` error at test time:

- `device.clearAppData(...)` — physical devices don't expose their app container filesystem to the host. Use `--force-install` on `pilot test` to reinstall the app bundle instead.
- `device.setClipboard(...)` / `device.getClipboard(...)` — blocked by the iOS 16+ paste permission dialog. Workaround: seed/read the clipboard from within your app via a test-only debug hook.
- `device.openDeepLink(...)` — `xcrun simctl openurl` is simulator-only and no `devicectl` equivalent exists. Workaround: add a test-only button in your app that calls `UIApplication.shared.open(url)`.
- `device.setColorScheme(...)` — simulator-only (`xcrun simctl ui appearance`). Set light/dark mode manually on the device before the test.
- `device.grantPermission(...)` / `device.revokePermission(...)` — `xcrun simctl privacy` is simulator-only. Workaround: trigger the in-app permission dialog during the test and let the XCUITest UIInterruptionMonitor tap through it automatically.
- `device.saveAppState(...)` / `device.restoreAppState(...)` — simulator-only filesystem access. Use simulator-based setup projects for reusable auth state.

Other caveats:

- **Slow test resets.** Physical devices don't have the simctl fast-path Pilot uses for simulator `restartApp`. Instead the agent performs a full XCUITest relaunch, which takes ~8s per reset.
- **Free Apple Developer accounts expire provisioning profiles weekly.** Rerun `pilot build-ios-agent` when you hit signing errors.
- **VPN apps on the device bypass HTTP proxy.** Network capture won't see traffic that a VPN is handling.
- **Only one test run per physical device at a time.** The dispatcher already assigns one device per worker — this isn't a new restriction, just worth knowing.

## Troubleshooting

Run `pilot setup-ios-device` first — it surfaces most setup issues with actionable fix instructions. If you're hitting build or install issues not caught by the preflight, the common failure modes are:

**"No Account for Team 'XXXXXXXXXX'"** — Xcode doesn't have the Apple ID that owns that team signed in. Open Xcode → Settings → Accounts and sign in.

**"No profiles for 'dev.pilot.agent.xctrunner' were found"** — Your device isn't registered under the selected team. Open Xcode → Window → Devices and Simulators, plug in the device, and wait for auto-registration.

**"Developer Mode disabled"** — Settings → Privacy & Security → Developer Mode → On, then reboot the device.

**"Unable to install PilotAgentUITests-Runner"** after the install step — the developer profile isn't trusted on the device. Settings → General → VPN & Device Management → trust the Pilot developer profile.

**"iproxy not found"** — `brew install libimobiledevice`.

**`Password:` prompt mid-test, right after "Starting iOS agent…"** — Xcode's CoreDevice mounts the Developer Disk Image via `sudo -- /usr/bin/true` to prime the sudo cache, and the prompt only appears in the first `xcodebuild` invocation per macOS login session. Pilot itself doesn't call sudo. Eliminate the prompt permanently with one command:

```sh
sudo DevToolsSecurity -enable
```

That adds your user to the `_developer` group so all subsequent Xcode-driven operations skip the auth check. `pilot setup-ios-device` flags this with a ⚠ advisory and the same fix.

**"Device unpaired" in `pilot setup-ios-device`** — open Xcode → Window → Devices and Simulators, wait for the device, click "Use for Development".

**"Developer Disk Image not mounted"** — this usually resolves on the first `xcodebuild -destination id=<udid>` run. It can also be triggered manually by opening the device in Xcode → Window → Devices and Simulators.
