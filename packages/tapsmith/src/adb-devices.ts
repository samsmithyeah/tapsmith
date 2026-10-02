/**
 * Parsing `adb devices` output, shared by `doctor` and the test-run paths
 * (`emulator.ts` `listAdbDevices`) so both see adb's whole device state —
 * the same state the daemon reports in `ListDevicesResponse.unusable_devices`.
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
