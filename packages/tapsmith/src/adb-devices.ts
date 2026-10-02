/**
 * `adb devices` states and what to do about them. Parsing is shared by
 * `doctor` and the test-run paths (`emulator.ts` `listAdbDevices`) so both
 * see adb's whole device state — the same state the daemon reports in
 * `ListDevicesResponse.unusable_devices` — and the advice by `doctor`,
 * `list-devices` and the run paths' device errors (`device-advice.ts`).
 * Dependency-free on purpose: the MCP server and the runner import it.
 */

// ─── ADB device listing ───

export interface AdbDevice {
  serial: string;
  state: string;
}

/**
 * Parse plain `adb devices` output. Each device line is the serial, a tab,
 * and adb's whole state — which can be several words (`no permissions
 * (missing udev rules? …); see […]` on Linux without a udev rule), so the
 * line is split at its first tab only and never truncated to the state's
 * first word. The header and adb's `* daemon …` start-up notices (no tab)
 * are skipped by content, wherever they appear.
 */
export function parseAdbDevicesOutput(output: string): AdbDevice[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes('\t') && !line.startsWith('*') && !line.startsWith('List of devices'))
    .map((line) => {
      const tab = line.indexOf('\t');
      return { serial: line.slice(0, tab).trim(), state: line.slice(tab + 1).trim() };
    })
    .filter((device) => device.serial.length > 0 && device.state.length > 0);
}

// ─── Advice for unusable states ───

/**
 * What to do about an attached Android device adb cannot use, by its
 * `adb devices` state; undefined for a usable (`device`) or unknown state.
 * Shared by `list-devices`, `doctor` and the test-run paths' device errors
 * (`device-advice.ts`) so they all give the same advice.
 */
export function androidStateBlocker(state: string, serial: string): string | undefined {
  // adb surfaces "unauthorized" when the device hasn't accepted the RSA key
  // yet and "offline" when the connection is broken — or, for an emulator,
  // while it is still booting.
  if (state === 'unauthorized') return 'Accept the USB debugging prompt on the device';
  if (state === 'offline' && serial.startsWith('emulator-')) return 'Wait for the emulator to finish booting, or restart it if it stays offline';
  if (state === 'offline') return 'Reconnect cable or run `adb kill-server`';
  // Linux without a udev rule: "no permissions (user … not in the plugdev group …)".
  if (state.startsWith('no permissions')) {
    return 'Give your user USB access to the device: add a udev rule for it and join the plugdev group (https://developer.android.com/studio/run/device)';
  }
  return undefined;
}

/**
 * The fix for an Android device in any adb state but `device`: the specific
 * advice from {@link androidStateBlocker}, or a generic one for states it has
 * none for (`authorizing`, `recovery`, …). Shared by `list-devices` and
 * `doctor`.
 */
export function androidUnusableDeviceFix(state: string, serial: string): string {
  return androidStateBlocker(state, serial)
    ?? `${serial} is "${state}" to adb: reconnect it, or run \`adb kill-server\` and try again`;
}
