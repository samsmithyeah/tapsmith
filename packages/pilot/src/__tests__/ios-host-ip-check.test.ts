import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  sidecarPathForDevice,
  readDeviceSidecar,
  checkHostIpDrift,
  getCurrentHostIp,
} from '../ios-host-ip-check.js';

const TEST_UDID = '00008140-TESTDEVICE';
const sidecarPath = sidecarPathForDevice(TEST_UDID);

function writeSidecar(hostIp: string): void {
  fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
  fs.writeFileSync(
    sidecarPath,
    JSON.stringify({
      udid: TEST_UDID,
      device_name: 'Test iPhone',
      host_ip: hostIp,
      port: 9000,
      ssid: 'TestNet',
      generated_at: new Date().toISOString(),
    }),
  );
}

afterEach(() => {
  if (fs.existsSync(sidecarPath)) fs.rmSync(sidecarPath);
  vi.restoreAllMocks();
});

describe('sidecarPathForDevice', () => {
  it('resolves under ~/.pilot/devices', () => {
    const p = sidecarPathForDevice('abc');
    expect(p).toBe(path.join(os.homedir(), '.pilot', 'devices', 'abc.meta.json'));
  });
});

describe('readDeviceSidecar', () => {
  it('returns undefined when no sidecar exists', () => {
    expect(readDeviceSidecar(TEST_UDID)).toBeUndefined();
  });

  it('parses a valid sidecar', () => {
    writeSidecar('192.168.1.10');
    const parsed = readDeviceSidecar(TEST_UDID);
    expect(parsed?.host_ip).toBe('192.168.1.10');
    expect(parsed?.udid).toBe(TEST_UDID);
  });

  it('returns undefined for malformed JSON', () => {
    fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
    fs.writeFileSync(sidecarPath, '{ not valid json');
    expect(readDeviceSidecar(TEST_UDID)).toBeUndefined();
  });
});

describe('checkHostIpDrift', () => {
  it('returns ok=true with noSidecar when no profile exists', () => {
    const result = checkHostIpDrift(TEST_UDID);
    expect(result.ok).toBe(true);
    expect(result.noSidecar).toBe(true);
  });

  it('returns ok=false when sidecar and current IP differ', () => {
    writeSidecar('10.99.99.99'); // unlikely to match the test host's real IP
    const current = getCurrentHostIp();
    if (current === '10.99.99.99') {
      // Extremely unlikely, but skip rather than fail flakily.
      return;
    }
    const result = checkHostIpDrift(TEST_UDID);
    if (result.currentHostIp === undefined) return; // env can't detect IP
    expect(result.ok).toBe(false);
    expect(result.sidecarHostIp).toBe('10.99.99.99');
  });
});
