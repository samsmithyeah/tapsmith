import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildDoctorJson, isSupportedNodeVersion, parseAvdImageTag, scanAvdImageTags, type CheckEntry } from '../doctor.js';

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

describe('isSupportedNodeVersion()', () => {
  it('requires Node.js 22 or newer', () => {
    expect(isSupportedNodeVersion('21.9.0')).toBe(false);
    expect(isSupportedNodeVersion('22.0.0')).toBe(true);
    expect(isSupportedNodeVersion('24.13.0')).toBe(true);
  });
});

describe('parseAvdImageTag()', () => {
  it('extracts tag.id from config.ini', () => {
    const ini = 'AvdId = Medium_Phone\nPlayStore.enabled = true\ntag.id = google_apis_playstore\ntag.ids = google_apis_playstore\n';
    expect(parseAvdImageTag(ini)).toBe('google_apis_playstore');
  });

  it('handles google_apis images and whitespace variants', () => {
    expect(parseAvdImageTag('tag.id=google_apis\n')).toBe('google_apis');
    expect(parseAvdImageTag('tag.id =  google_apis \n')).toBe('google_apis');
  });

  it('returns undefined when tag.id is absent', () => {
    expect(parseAvdImageTag('AvdId = X\n')).toBeUndefined();
    // tag.ids must not match tag.id
    expect(parseAvdImageTag('tag.ids = google_apis\n')).toBeUndefined();
  });
});

describe('scanAvdImageTags()', () => {
  function makeAvdHome(avds: Array<{ name: string; tagId?: string }>): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-avd-test-'));
    for (const avd of avds) {
      const avdDir = path.join(home, `${avd.name}.avd`);
      fs.mkdirSync(avdDir);
      fs.writeFileSync(path.join(home, `${avd.name}.ini`), `avd.ini.encoding=UTF-8\npath=${avdDir}\npath.rel=avd/${avd.name}.avd\n`);
      const tagLine = avd.tagId ? `tag.id = ${avd.tagId}\n` : '';
      fs.writeFileSync(path.join(avdDir, 'config.ini'), `AvdId = ${avd.name}\n${tagLine}`);
    }
    return home;
  }

  it('returns each AVD with its system image tag', () => {
    const home = makeAvdHome([
      { name: 'Pixel_7', tagId: 'google_apis' },
      { name: 'Medium_Phone', tagId: 'google_apis_playstore' },
    ]);
    const avds = scanAvdImageTags(home).sort((a, b) => a.name.localeCompare(b.name));
    expect(avds).toEqual([
      { name: 'Medium_Phone', tagId: 'google_apis_playstore' },
      { name: 'Pixel_7', tagId: 'google_apis' },
    ]);
  });

  it('keeps AVDs whose config.ini is unreadable, without a tag', () => {
    const home = makeAvdHome([{ name: 'Pixel_7', tagId: 'google_apis' }]);
    fs.writeFileSync(path.join(home, 'Broken.ini'), 'path=/nonexistent/Broken.avd\n');
    const avds = scanAvdImageTags(home).sort((a, b) => a.name.localeCompare(b.name));
    expect(avds).toEqual([
      { name: 'Broken', tagId: undefined },
      { name: 'Pixel_7', tagId: 'google_apis' },
    ]);
  });

  it('returns empty for a missing AVD home', () => {
    expect(scanAvdImageTags('/nonexistent/avd-home')).toEqual([]);
  });
});
