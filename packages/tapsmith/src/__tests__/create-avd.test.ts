import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  defaultAbi,
  defaultAvdName,
  findSdkTool,
  parseCreateAvdArgs,
  systemImageDir,
  systemImagePackage,
  DEFAULT_API_LEVEL,
  DEFAULT_DEVICE_PROFILE,
} from '../create-avd.js';

describe('parseCreateAvdArgs()', () => {
  it('applies defaults when no flags are given', () => {
    const opts = parseCreateAvdArgs([]);
    expect(opts).toEqual({
      api: DEFAULT_API_LEVEL,
      name: `Tapsmith_Phone_API_${DEFAULT_API_LEVEL}`,
      device: DEFAULT_DEVICE_PROFILE,
      abi: defaultAbi(),
      force: false,
      help: false,
    });
  });

  it('derives the default name from a custom API level', () => {
    expect(parseCreateAvdArgs(['--api', '34']).name).toBe('Tapsmith_Phone_API_34');
    expect(parseCreateAvdArgs(['--api=34']).api).toBe(34);
  });

  it('accepts explicit name, device, abi, and force', () => {
    const opts = parseCreateAvdArgs(['--name', 'My_AVD', '--device=pixel_7', '--abi', 'x86_64', '--force']);
    expect(opts.name).toBe('My_AVD');
    expect(opts.device).toBe('pixel_7');
    expect(opts.abi).toBe('x86_64');
    expect(opts.force).toBe(true);
  });

  it('parses --help', () => {
    expect(parseCreateAvdArgs(['--help']).help).toBe(true);
    expect(parseCreateAvdArgs(['-h']).help).toBe(true);
  });

  it('rejects invalid API levels', () => {
    expect(() => parseCreateAvdArgs(['--api', 'banana'])).toThrow(/Invalid API level/);
    expect(() => parseCreateAvdArgs(['--api', '-3'])).toThrow(/Invalid API level/);
    expect(() => parseCreateAvdArgs(['--api', '34.5'])).toThrow(/Invalid API level/);
  });

  it('rejects invalid AVD names', () => {
    expect(() => parseCreateAvdArgs(['--name', 'has spaces'])).toThrow(/Invalid AVD name/);
  });

  it('rejects unknown flags and missing values', () => {
    expect(() => parseCreateAvdArgs(['--bogus'])).toThrow(/Unknown flag/);
    expect(() => parseCreateAvdArgs(['--name'])).toThrow(/Missing value/);
  });
});

describe('defaultAbi()', () => {
  it('maps host architectures to emulator ABIs', () => {
    expect(defaultAbi('arm64')).toBe('arm64-v8a');
    expect(defaultAbi('x64')).toBe('x86_64');
  });
});

describe('systemImagePackage()', () => {
  it('always selects the rootable google_apis image', () => {
    expect(systemImagePackage(36, 'arm64-v8a')).toBe('system-images;android-36;google_apis;arm64-v8a');
    expect(systemImagePackage(33, 'x86_64')).toBe('system-images;android-33;google_apis;x86_64');
  });
});

describe('systemImageDir()', () => {
  it('matches where sdkmanager unpacks the image', () => {
    expect(systemImageDir('/sdk', 36, 'arm64-v8a'))
      .toBe(path.join('/sdk', 'system-images', 'android-36', 'google_apis', 'arm64-v8a'));
  });
});

describe('defaultAvdName()', () => {
  it('embeds the API level', () => {
    expect(defaultAvdName(36)).toBe('Tapsmith_Phone_API_36');
  });
});

describe('findSdkTool()', () => {
  it('prefers cmdline-tools/latest under ANDROID_HOME', () => {
    const sdkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-sdk-test-'));
    const binDir = path.join(sdkRoot, 'cmdline-tools', 'latest', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const tool = path.join(binDir, process.platform === 'win32' ? 'sdkmanager.bat' : 'sdkmanager');
    fs.writeFileSync(tool, '');
    expect(findSdkTool('sdkmanager', { ANDROID_HOME: sdkRoot })).toBe(tool);
  });

  it('falls back to the bare tool name when not found under the SDK root', () => {
    expect(findSdkTool('sdkmanager', { ANDROID_HOME: '/nonexistent' }))
      .toBe(process.platform === 'win32' ? 'sdkmanager.bat' : 'sdkmanager');
    expect(findSdkTool('avdmanager', {})).toBe(process.platform === 'win32' ? 'avdmanager.bat' : 'avdmanager');
  });
});
