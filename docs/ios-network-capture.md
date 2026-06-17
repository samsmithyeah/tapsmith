# iOS network capture

Tapsmith can record the HTTP/HTTPS traffic the app under test makes during iOS tests, with full request/response bodies, headers, timing, and per-test attribution in the trace viewer's Network tab. Both **iOS simulators** and **physical iOS devices** are supported on macOS.

Simulators go through a macOS Network Extension (no on-device configuration needed — see [simulator setup](#first-run-setup) below). Physical devices use a Wi-Fi proxy configuration profile (a `.mobileconfig` that Tapsmith generates per device) — see the [physical device section](#physical-ios-devices) below.

## How it works

Tapsmith's daemon (`tapsmith-core`) runs a local MITM proxy for each worker. On Android the daemon uses `adb reverse` to forward the proxy port onto the device and configures the device's HTTP proxy setting. **On iOS**, it uses a different mechanism because simulators share the host's network stack:

- The daemon spawns **`Mitmproxy Redirector.app`**, a small signed launcher that ships with [mitmproxy](https://mitmproxy.org) and manages a macOS **Network Extension** (NE). The NE intercepts TCP flows from specific PIDs on the host and redirects them over a per-worker Unix socket into Tapsmith's MITM proxy.
- The daemon resolves the booted simulator's process tree (`launchd_sim` and descendants) and sends the resulting PID list to the NE as an `InterceptConf`. The NE filters traffic per-PID, so each worker daemon only sees its own simulator's flows — **parallel iOS workers don't collide**, and the user's host browser traffic is never touched.
- The MITM proxy reads the real hostname from the client's TLS ClientHello SNI extension (not the resolved IP the NE reports), dials upstream with that hostname as SNI, mints a per-host certificate signed by the Tapsmith CA, and captures the decrypted request/response pair into the trace.

The CA is installed into the simulator's trust store automatically via `xcrun simctl keychain add-root-cert` at the start of each capture session.

## First-run setup

**Prerequisite:** macOS with [Homebrew](https://brew.sh).

The fastest path is to use Tapsmith's interactive setup command, which checks your environment, extracts the redirector automatically, and walks you through approving the macOS Network Extension:

```sh
brew install mitmproxy
npx tapsmith setup-ios
```

`tapsmith setup-ios` reports each step with a ✓ / ✗ status, opens System Settings directly to the correct pane if approval is still needed, and polls until the Network Extension flips to `[activated enabled]`. On a fresh machine you'll see:

1. `✓ mitmproxy is installed`
2. `⚠ Network Extension is registered but not yet approved` (or `○ not yet registered` on a brand-new install)
3. Tapsmith opens **System Settings → General → Login Items & Extensions → Network Extensions**
4. Click **(i)** next to the `Network Extensions` row, toggle **Mitmproxy Redirector** on, enter your password
5. Tapsmith detects the state change and prints `✓ iOS network capture is ready.`

From this point on, `npx tapsmith test` with iOS network capture enabled (the default when tracing is on) silently spawns the redirector and routes traffic through Tapsmith's MITM proxy.

### If the Network Extension isn't registered yet

On a truly fresh machine the Network Extension is registered the first time Tapsmith spawns the redirector (which happens automatically on your first `tapsmith test` run with tracing). If `tapsmith setup-ios` reports `○ not yet registered`, do the following:

1. Run any iOS test once to trigger the registration prompt:
   ```sh
   npx tapsmith test tests/some-ios-test.ts --trace on
   ```
   (Or any test with tracing enabled.)
2. macOS will show a **"System Extension Blocked"** dialog. Click through to System Settings.
3. Approve the extension in **System Settings → General → Login Items & Extensions → Network Extensions**.
4. Re-run `npx tapsmith setup-ios` to verify, or just re-run your tests.

### Manual fallback

If you prefer to do the setup by hand (or if `tapsmith setup-ios` doesn't work for some reason):

```sh
brew install mitmproxy
sudo mitmproxy --mode local:Safari   # press `q` to quit once it launches
```

Then open **System Settings → General → Login Items & Extensions → Network Extensions**, click the **(i)** info button, and toggle **Mitmproxy Redirector** on.

Verify with:

```sh
systemextensionsctl list
```

You should see a row ending in `[activated enabled]` for `org.mitmproxy.macos-redirector.network-extension`.

## Configuration

Network capture is on by default whenever tracing is enabled. Control it via the `network` field in `TraceConfig`:

```typescript
// tapsmith.config.mjs
import { defineConfig } from "tapsmith";

export default defineConfig({
  platform: "ios",
  trace: {
    mode: "retain-on-failure",
    network: true, // default — set to false to disable capture
  },
  // ...
});
```

To opt out of iOS network capture entirely, set `network: false`. No mitmproxy install or SE approval is needed in that case.

### Overriding the redirector location

By default, Tapsmith looks for the redirector at:

1. The path in `$TAPSMITH_REDIRECTOR_APP` (if set)
2. `/Applications/Mitmproxy Redirector.app/Contents/MacOS/Mitmproxy Redirector` (the brew unpack location)
3. `~/.tapsmith/redirector/Mitmproxy Redirector.app/Contents/MacOS/Mitmproxy Redirector` (on-demand extract from the brew cask tarball)

Set `TAPSMITH_REDIRECTOR_APP=/path/to/Mitmproxy Redirector.app/Contents/MacOS/Mitmproxy Redirector` to point at a custom location (e.g. a CI-managed redirector, or a hand-signed Tapsmith fork).

## CI setup

See the [iOS network capture on CI](./ci-setup.md#ios-network-capture-on-ci) section for `brew install mitmproxy` + SE approval on CI runners.

## Troubleshooting

### `Mitmproxy Redirector.app not found`

The redirector binary is missing. Run the [first-run setup](#first-run-setup) above, or set `TAPSMITH_REDIRECTOR_APP` to point at an existing redirector binary. The error message lists the fallback search paths.

### System Extension is installed but `[activated waiting for user]`

You installed the SE but haven't approved it yet. Go to **System Settings → General → Login Items & Extensions → Network Extensions → (i)** and toggle it on. The state should change to `[activated enabled]`.

### SE control-channel timeout

Error text:

```
[tapsmith] Network capture disabled: Mitmproxy Redirector System Extension did not connect within 10s.
```

Tapsmith waits up to 10 s for the macOS System Extension to dial back into its per-daemon Unix socket after spawning the redirector launcher. If that doesn't happen, capture is disabled for the session (tests still run, just without network data in the trace).

**Usual cause.** A previous Tapsmith session left a stuck `Mitmproxy Redirector` process behind — typically one that got orphaned when tapsmith-core was SIGKILL'd (crash, IDE restart, `pkill node`). Stuck redirectors often sit in `UE` or `Z` state and can wedge the SE's ability to accept a new control-channel connection.

Tapsmith now **auto-cleans orphaned redirectors at startup** (looks for redirector processes whose owning tapsmith-core PID is dead and `kill -9`s them before spawning a new one). That handles the common case invisibly. If you still hit the timeout, try in order:

1. **Force-clean manually:**
   ```sh
   pkill -9 -f 'Mitmproxy Redirector'
   rm -f /tmp/tapsmith-redirector-*.sock
   ```
   Then re-run `tapsmith test`.

2. **Check system load.** On a busy machine (load average > 10), the SE can genuinely need more than 10 s to respond. Quit other heavy processes (Xcode builds, other emulators) and retry. `uptime` will show the load averages.

3. **Reboot macOS.** The Network Extension's state can drift over long uptime or across macOS updates. A reboot resets both the SE and any lingering kernel state.

4. **Re-run setup.**
   ```sh
   npx tapsmith setup-ios
   ```
   This re-registers the SE and can recover from registration glitches.

Verify success on the next run by looking for `System Extension control channel connected` in the daemon debug logs (`RUST_LOG=tapsmith_core=debug`).

### Network entries missing from the trace (`network.json` not in the archive)

Check the daemon logs — run `tapsmith test` with `RUST_LOG=tapsmith_core=debug` and look for lines from `tapsmith_core::ios_redirect` (control channel connection, initial InterceptConf, intercepted flows) and `tapsmith_core::network_proxy` (MITM handshakes). Common causes:

- **`failed reading TLS ClientHello`** — the app closed the connection before sending the handshake. Usually a transient issue; rerun the test.
- **`upstream TLS handshake failed for <host>: UnknownIssuer`** — the upstream server uses a certificate chain not in Tapsmith's webpki roots. This affects some Apple-internal services; it does not affect standard public HTTPS endpoints.
- **`simulator_processes returned 0 PIDs`** — the simulator isn't booted, or `ps` parsing couldn't find it. Check `xcrun simctl list devices booted`.

### Firestore, gRPC, and IPv6

Firestore and many Firebase real-time services use gRPC, which requires HTTP/2. Tapsmith tunnels these connections end-to-end rather than decrypting them, but on iOS simulators the macOS Network Extension still observes the simulator's outbound IPv6 connection attempt before the tunnel is established.

If the Mac has IPv6 disabled, or the current network has no usable IPv6 route, those simulator connections can sit on an unsatisfied IPv6 path long enough to look like a Firestore load hang. This is host/network dependent: it is most likely on Macs where **Configure IPv6** is set to **Off**, on VPN/corporate networks that disable IPv6, or on networks with broken IPv6 routing.

Symptoms:

- The same Firestore/gRPC-backed screen works when `trace.network` is `false`.
- The stall only happens on iOS simulator network capture, not Android or physical iOS capture.
- HTTP/1.1 REST traffic still appears normally in the trace.
- `npx tapsmith doctor` reports that host IPv6 is unavailable for iOS simulator capture.

Check the Mac:

```sh
npx tapsmith doctor
networksetup -getinfo Wi-Fi
route -n get -inet6 2001:4860:4860::8888
```

On a healthy macOS setup, `networksetup` usually reports `IPv6: Automatic` and the `route` command returns a route. To fix the issue, enable IPv6 for the active network service (**System Settings > Network > Wi-Fi > Details > TCP/IP > Configure IPv6 > Automatically**) or run:

```sh
sudo networksetup -setv6automatic Wi-Fi
```

If you cannot enable IPv6 on the current network, set `trace.network: false` for affected Firestore/gRPC tests or run those flows without iOS simulator network capture.

### My host's web browser traffic went through Tapsmith's proxy

This should not happen with PILOT-182's NE-based approach. The NE filters by PID, so only the simulator's process tree's traffic is redirected; your browser's PID is not in the filter. If you are still seeing host traffic being affected, check that `networksetup -getwebproxy Wi-Fi` shows `Enabled: No`. If a stale proxy setting is still configured from a pre-PILOT-182 Tapsmith version, clear it with:

```sh
sudo networksetup -setwebproxystate Wi-Fi off
sudo networksetup -setsecurewebproxystate Wi-Fi off
```

You can also remove the (no-longer-used) legacy sudoers file:

```sh
sudo rm /etc/sudoers.d/zzz-tapsmith-networksetup
```

Tapsmith itself never modifies these on modern versions.

### Parallel iOS workers still see empty network tabs

Verify the fix is in place: run with debug logs and look for `tapsmith_core::ios_redirect` lines showing **different `/tmp/tapsmith-redirector-*.sock` paths per worker**. Each worker daemon should have its own session. If multiple workers share a socket path, you are running an older build — upgrade.

### Physical iOS device network capture

See the [Physical iOS devices](#physical-ios-devices) section below — physical devices use a different setup flow (`tapsmith configure-ios-network`) because they can't share the macOS Network Extension that simulators use.

## Physical iOS devices

Physical iPhones/iPads have their own network stack — the macOS Network Extension redirector used for simulators only intercepts host-originated traffic, so it can't route a real device. Tapsmith therefore uses a different mechanism for physical devices: a per-device **configuration profile** (`.mobileconfig`) that installs a Wi-Fi HTTP proxy on the device pointing at the host Mac's LAN IP, plus the Tapsmith MITM CA.

### How it works (physical)

1. `tapsmith configure-ios-network <udid>` generates a `.mobileconfig` containing two payloads:
   - `com.apple.wifi.managed` — targets your current Wi-Fi SSID with `ProxyType: Manual`, `ProxyServer: <host-ip>`, `ProxyServerPort: <deterministic-port>`. The port is `9000 + CRC32(udid) % 1000`, so it's stable per device and multiple devices can run in parallel without colliding.
   - `com.apple.security.root` — the Tapsmith CA, for HTTPS trust.
2. You install the profile on the device once (AirDrop / email / Messages) and trust the CA in **Settings → General → About → Certificate Trust Settings**.
3. When `tapsmith test` targets that device, the daemon binds its MITM proxy on `0.0.0.0:<deterministic-port>` so the device can reach it over Wi-Fi. Traffic flows through the same MITM engine as the simulator path, producing identical `NetworkEntry` records in the trace.

### First-run setup (physical)

Prerequisites — run `tapsmith setup-ios-device` to check these automatically:

- Xcode 15+ with command-line tools
- `libimobiledevice` installed (`brew install libimobiledevice`)
- A signed TapsmithAgent built for iOS device (`tapsmith build-ios-agent`)
- Your device plugged in via USB, paired with Xcode, Developer Mode enabled

Then, for each physical device you want to test against:

```sh
# 1. Verify environment + see the device's UDID
tapsmith setup-ios-device

# 2. Generate the mobileconfig (auto-detects host Wi-Fi IP, SSID, device name)
tapsmith configure-ios-network <UDID>
```

Follow the on-screen walkthrough to install the profile on the device:

1. AirDrop the generated `~/.tapsmith/devices/<UDID>.mobileconfig` to the iPhone (or email it).
2. On the device, open **Settings → General → VPN & Device Management**, tap the "Tapsmith Network Capture" profile, then "Install" → enter passcode → "Install".
3. Trust the CA: **Settings → General → About → Certificate Trust Settings → Tapsmith MITM CA → full trust**.

From then on, `tapsmith test` against that UDID with tracing enabled will capture traffic.

### Scoping what gets captured (physical only)

iOS applies the `com.apple.wifi.managed` HTTP proxy **system-wide** — there's no per-app scoping available without MDM enrollment. The MITM proxy therefore sees traffic from every app and background service running on the device, not just the app under test. iOS's own chatty background services (captive portal checks, Apple ID refresh, analytics, iCloud sync) will show up in the trace alongside your app's requests.

Use `trace.networkHosts` in your config to scrub the noise:

```ts
import { defineConfig } from 'tapsmith'

export default defineConfig({
  platform: 'ios',
  device: '00008140-00096C9014F3001C',
  trace: {
    mode: 'on',
    // Only keep entries whose hostname matches one of these patterns.
    // Glob syntax: `*` matches any number of characters;
    // `*.example.com` matches `api.example.com`, `cdn.example.com`,
    // and `example.com` itself. Case-insensitive.
    networkHosts: ['*.myapp.com', 'api.partner.example'],
  },
})
```

Tapsmith applies the filter when stopping the capture, so filtered-out entries never touch the trace archive. If you don't set `networkHosts`, every entry is kept (current behaviour).

**Simulators** already filter per-PID at the kernel level via the macOS Network Extension redirector, so `networkHosts` is mostly redundant on sim runs — but it still works there if you want belt-and-braces filtering.

### Running parallel physical devices

The deterministic per-UDID port means multiple physical devices on the same Wi-Fi network each get their own host port without collision. Run `tapsmith configure-ios-network` once per device; each installs a profile with a distinct port, and parallel worker buckets dispatch independently.

### When the host's Wi-Fi IP changes

The mobileconfig embeds the host's LAN IP at generation time. If you move between Wi-Fi networks (or DHCP reassigns your IP), the installed profile goes stale and the device will hit connection-refused when it tries the proxy. Regenerate:

```sh
tapsmith refresh-ios-network <UDID>
```

Then remove the old profile on the device (**Settings → General → VPN & Device Management → Tapsmith Network Capture → Remove Profile**) and install the new one.

Tapsmith also detects this at test time: if the daemon notices that the host's current Wi-Fi IP doesn't match the IP recorded in `~/.tapsmith/devices/<UDID>.meta.json`, it prints a warning in the trace with the `refresh-ios-network` command to run.

### Troubleshooting (physical)

**"No Tapsmith network profile found for device …"** — you haven't generated the mobileconfig yet. Run `tapsmith configure-ios-network <UDID>`.

**"Host Wi-Fi IP changed since mobileconfig was generated"** — see [When the host's Wi-Fi IP changes](#when-the-hosts-wi-fi-ip-changes).

**The device isn't routing traffic through the proxy** — check that the device is actually on the SSID the mobileconfig targets (not cellular or a different Wi-Fi). Also confirm the profile is installed and CA trust is enabled.

**HTTPS requests fail with certificate errors** — the Tapsmith CA isn't trusted on the device. Go to **Settings → General → About → Certificate Trust Settings** and enable full trust for "Tapsmith MITM CA".

**A VPN app is installed on the device** — VPN apps bypass Wi-Fi HTTP proxy. Disable the VPN for the duration of testing. This is a known limitation.

**Device signing expired (free Apple Developer account)** — free accounts rotate profiles every 7 days. Rerun `tapsmith build-ios-agent` to refresh the signed runner.

## Security and privacy

- The Tapsmith CA is generated once per machine and stored under `~/.tapsmith/ca.pem`. It is installed into the simulator's trust store at the start of the first capture session and **persists** there across subsequent runs. Tapsmith does not currently remove the CA at session end — to wipe it, `xcrun simctl erase <udid>` (erases the simulator) or remove the cert manually from the simulator's keychain.
- Only traffic from the simulator's process tree (as reported by `ps`) is routed through the proxy. Host browsers, IDEs, and other apps are unaffected.
- The macOS system proxy (`networksetup -setwebproxy`) is never modified. Tapsmith's PILOT-182 architecture removed all host-level proxy configuration.
- Request and response bodies are truncated to 1 MiB each in the captured trace to prevent runaway memory usage.

## Attribution

Tapsmith's iOS network capture builds on the [mitmproxy](https://mitmproxy.org) project's `mitmproxy_rs` macOS redirector, which is MIT-licensed. Specifically, Tapsmith vendors the `mitmproxy_ipc.proto` schema (in `packages/tapsmith-core/vendor/mitmproxy_ipc.proto`) and depends at runtime on the `Mitmproxy Redirector.app` binary shipped with `brew install mitmproxy`. Tapsmith does not bundle or fork mitmproxy itself.

MIT License © Mitmproxy contributors — see the [mitmproxy_rs LICENSE](https://github.com/mitmproxy/mitmproxy_rs/blob/main/LICENSE).
