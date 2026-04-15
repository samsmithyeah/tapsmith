# iOS physical device network capture

Decrypted HTTPS request/response bodies in your traces, on real iPhones/iPads. **You don't need this for basic testing** — if you just want to run tests on a real device, start with [iOS physical devices](./ios-physical-devices.md).

This page covers the extra one-time setup: installing a mobileconfig profile on the device that routes Wi-Fi traffic through Pilot's MITM proxy, then trusting Pilot's CA so iOS will decrypt HTTPS.

## Prerequisites

- Everything in [iOS physical devices](./ios-physical-devices.md) already working — a test must run green before adding network capture
- The device and the Mac on the same Wi-Fi network

## Enable network tracing in your config

```ts
import { defineConfig } from 'pilot';

export default defineConfig({
  platform: 'ios',
  app: './build/MyApp-Device.app',
  package: 'com.example.myapp',
  trace: {
    mode: 'on',
    // Strongly recommended on physical iOS — the Wi-Fi proxy is system-wide
    // so the trace otherwise includes every app and background service.
    networkHosts: ['*.myapp.com', 'api.example.com'],
  },
});
```

With `trace.mode` off, Pilot's daemon skips every network-capture code path — no proxy pre-start, no OCSP passthrough, nothing. Flipping `trace.mode` on is the switch that turns everything on this page from "dead code" to "active".

## One-time device setup

Run this command. It handles stealth mode, SSID detection, profile generation, and drops a walkthrough for the on-device steps:

```sh
pilot configure-ios-network <udid> --fix-firewall
```

What it does:

1. **Disables macOS Application Firewall stealth mode** (if on). Stealth mode silently drops inbound TCP SYNs to user processes — even binaries that are explicitly allowed in the firewall list. Without this, the iPhone on Wi-Fi can't reach the Pilot proxy on the Mac's LAN IP and traces will show zero network entries. `--fix-firewall` runs the sudo command for you (prompts once for password); without the flag Pilot just prints the command for you to run manually.
2. **Detects the current Wi-Fi SSID**, or prompts you for one interactively if macOS won't reveal it (14+ redacts SSID from `ipconfig getsummary` unless the calling process has Location Services permission — Pilot doesn't, so we ask). You can also pass `--ssid "Name"` explicitly.
3. **Generates the mobileconfig profile** under `~/.pilot/devices/<UDID>.mobileconfig` and reveals it in Finder for AirDrop.
4. **Prints the on-device walkthrough** — AirDrop, install, trust the Pilot CA.

Walk through the on-device steps once:

1. **Send** the profile. Finder has it pre-selected — right-click → Share → AirDrop → your iPhone. (Email / Messages work too.)
2. **Install** it. Settings shows a "Profile Downloaded" banner — tap it → Install → enter passcode → Install.
3. **Trust the Pilot CA.** Settings → General → About → Certificate Trust Settings → toggle **Pilot MITM CA**. This row only appears *after* step 2 — the profile install is what makes iOS reveal it.

Then verify end-to-end:

```sh
pilot verify-ios-network <udid>
```

This starts the proxy, asks you to load an HTTPS page in Safari, then reports whether Pilot saw the traffic and decrypted it. Catches the three common failure modes (profile not installed, CA not trusted, firewall blocking) with specific fix-it hints.

From then on, `pilot test` will capture full HTTPS traffic into the trace.

## What gets captured

The Wi-Fi HTTP proxy is applied **system-wide** by iOS — no per-app scoping is available without MDM enrollment. That means Pilot's MITM proxy sees traffic from every app and background service running on the device:

- iOS system services (captive portal checks, weather, analytics, iCloud sync)
- Any other app you have running (Mail, Safari, Messages, etc.)
- The app under test

Two things help:

1. **Use a host allowlist** in `pilot.config.ts`:

   ```ts
   trace: {
     mode: 'on',
     networkHosts: ['*.myapp.com', 'api.example.com'],
   }
   ```

   Only entries whose hostname matches one of the patterns end up in traces. `*` matches any number of characters, `*.example.com` matches `api.example.com`, `cdn.example.com`, and `example.com` itself. Case-insensitive.

2. **Close unrelated apps** on the phone. iOS background services are unavoidable but Mail / Safari / Messages go quiet.

On iOS **simulators** the filtering is handled per-PID at the kernel level by the macOS Network Extension redirector, so simulator runs aren't noisy and `networkHosts` is rarely needed there.

## Host IP drift

The mobileconfig profile bakes in the Mac's LAN IP at the time you ran `configure-ios-network`. If your Mac switches Wi-Fi networks (coffee shop → office), the baked-in IP goes stale and iOS silently fails to route traffic.

Pilot handles this for you: on every `pilot test` run with tracing enabled, the host-IP sidecar (`~/.pilot/devices/<udid>.meta.json`) is compared against the current Wi-Fi IP. If they differ, the profile is auto-regenerated and you're warned to reinstall it on the device. Profile regeneration is instant; the reinstall is a quick AirDrop-and-tap.

## Changing `trace.networkHosts`

Good news: iOS fetches the PAC script from the Pilot daemon very aggressively — empirically, on nearly every new host load, not just on Wi-Fi join. That means when you change `trace.networkHosts` in `pilot.config.ts`, the new filter takes effect on the next `pilot test` run with no manual intervention on the phone — no Wi-Fi toggle, no profile reinstall.

If you ever need to confirm iOS picked up a change, run the daemon with `RUST_LOG=info` and watch for `Served /pilot.pac` log lines with the expected `host_count` field.

You can also refresh manually:

```sh
pilot refresh-ios-network <udid>
```

## Known limitations

- **VPN apps on the device bypass HTTP proxy.** The MITM proxy won't see traffic the VPN is handling.
- **Certificate pinning breaks decryption** for specific apps that pin. The request shows up in the trace, but the body is unreadable.
- **Parallel device setup.** Each device gets its own deterministic port derived from its UDID, so multiple devices can share the same Mac and proxy process.

## Troubleshooting

**Traces show zero network entries.** Run `pilot verify-ios-network <udid>` — it walks through the three most common causes (stealth mode on, profile not installed, device not on the profile's Wi-Fi) and prints the specific fix.

**Traces show HTTPS entries with empty bodies.** The CA isn't trusted. Settings → General → About → Certificate Trust Settings → toggle Pilot MITM CA. Remember the row only appears after the mobileconfig profile is installed.

**"Device not routing through proxy"** after switching Wi-Fi networks. Run `pilot refresh-ios-network <udid>` and reinstall the new profile on the device. Pilot will flag this automatically on the next `pilot test` run.

**SSID detection bails with a redacted placeholder.** macOS 14+ redacts Wi-Fi SSIDs unless the process has Location Services permission. Pass `--ssid "YourWiFiName"` explicitly, or answer Pilot's interactive prompt.
