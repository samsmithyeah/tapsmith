import { describe, it, expect } from 'vitest';
import { buildDoctorJson, type CheckEntry } from '../doctor.js';

describe('buildDoctorJson()', () => {
  const checks: CheckEntry[] = [
    { id: 'node', status: 'pass', label: 'Node.js 22.1.0' },
    { id: 'adb', status: 'fail', label: 'ADB not found on PATH', fix: 'Install Android platform-tools and ensure adb is on PATH' },
    { id: 'android-home', status: 'warn', label: 'ANDROID_HOME not set', fix: 'Set ANDROID_HOME to your Android SDK location' },
  ];
  const inventory = {
    avds: ['Pixel_7'],
    simulators: [{ name: 'iPhone 16', udid: 'ABC', state: 'Shutdown', runtime: 'iOS 18 2' }],
    connectedDevices: [{ serial: 'emulator-5554', state: 'device' }],
  };

  it('sets ok=false when any check fails', () => {
    const json = buildDoctorJson(checks, inventory);
    expect(json.ok).toBe(false);
    expect(json.checks).toHaveLength(3);
    expect(json.inventory.avds).toEqual(['Pixel_7']);
  });

  it('sets ok=true when only warnings remain', () => {
    const json = buildDoctorJson(checks.filter((c) => c.status !== 'fail'), inventory);
    expect(json.ok).toBe(true);
  });

  it('preserves fix strings on non-pass checks', () => {
    const json = buildDoctorJson(checks, inventory);
    expect(json.checks.find((c) => c.id === 'adb')?.fix).toContain('platform-tools');
  });

  it('strips ANSI formatting from machine-readable check fields', () => {
    const json = buildDoctorJson([{
      id: 'daemon',
      status: 'pass',
      label: 'Tapsmith daemon found \x1b[2m(/tmp/bin)\x1b[0m',
      detail: '\x1b[31mdetail\x1b[0m',
      fix: '\x1b[33mfix\x1b[0m',
    }], inventory);

    expect(json.checks[0]).toMatchObject({
      label: 'Tapsmith daemon found (/tmp/bin)',
      detail: 'detail',
      fix: 'fix',
    });
  });
});
