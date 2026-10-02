import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  findDeviceXctestrun,
  describeMissingDeviceXctestrun,
  describeMissingExplicitXctestrun,
  staleExplicitXctestrunWarning,
  staleNpmDeviceBuild,
} from '../ios-device-resolve.js';
import { tapsmithPackageVersion } from '../ios-agent-paths.js';

// ─── Fixtures ───

const XCTESTRUN = 'TapsmithAgentUITests_TapsmithAgentUITests_iphoneos26.4-arm64.xctestrun';

let tmp: string;
let home: string;
let savedHome: string | undefined;

function writeBuild(productsDir: string, name = XCTESTRUN, mtime?: Date): string {
  fs.mkdirSync(productsDir, { recursive: true });
  const file = path.join(productsDir, name);
  fs.writeFileSync(file, '<plist/>');
  if (mtime) fs.utimesSync(file, mtime, mtime);
  return file;
}

const npmAgentDir = () => path.join(home, '.tapsmith', 'ios-agent');
const npmProducts = () => path.join(npmAgentDir(), '.build-device', 'Build', 'Products');
const writeMarker = (version: string) => {
  fs.mkdirSync(npmAgentDir(), { recursive: true });
  fs.writeFileSync(path.join(npmAgentDir(), '.tapsmith-version'), version);
};

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-resolve-')));
  home = path.join(tmp, 'home');
  fs.mkdirSync(home);
  savedHome = process.env.HOME;
  // os.homedir() reads HOME first on POSIX.
  process.env.HOME = home;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ─── findDeviceXctestrun ───

describe('findDeviceXctestrun (PILOT-264: npm-installed builds)', () => {
  it('finds a checkout build under ios-agent/.build-device in the start dir or a parent', () => {
    const repo = path.join(tmp, 'repo');
    const built = writeBuild(path.join(repo, 'ios-agent', '.build-device', 'Build', 'Products'));
    const project = path.join(repo, 'e2e', 'nested');
    fs.mkdirSync(project, { recursive: true });
    expect(findDeviceXctestrun(project)).toBe(built);
  });

  it('finds the npm build under ~/.tapsmith/ios-agent/.build-device from any project dir', () => {
    writeMarker(tapsmithPackageVersion());
    const built = writeBuild(npmProducts());
    const project = path.join(tmp, 'my-app');
    fs.mkdirSync(project);
    expect(findDeviceXctestrun(project)).toBe(built);
  });

  it('prefers a checkout build over the npm build', () => {
    writeMarker(tapsmithPackageVersion());
    writeBuild(npmProducts());
    const repo = path.join(tmp, 'repo');
    const checkout = writeBuild(path.join(repo, 'ios-agent', '.build-device', 'Build', 'Products'));
    expect(findDeviceXctestrun(repo)).toBe(checkout);
  });

  it('skips an npm build made by another Tapsmith version', () => {
    writeMarker('0.0.1-not-this-version');
    writeBuild(npmProducts());
    expect(findDeviceXctestrun(tmp)).toBeUndefined();
  });

  it('skips an npm build with no version marker', () => {
    writeBuild(npmProducts());
    expect(findDeviceXctestrun(tmp)).toBeUndefined();
  });

  it('ignores patched and simulator xctestruns in the npm build and returns the newest device one', () => {
    writeMarker(tapsmithPackageVersion());
    writeBuild(npmProducts(), XCTESTRUN.replace('.xctestrun', '.patched.xctestrun'), new Date(Date.now() + 60_000));
    writeBuild(npmProducts(), 'TapsmithAgentUITests_iphonesimulator26.4-arm64.xctestrun', new Date(Date.now() + 60_000));
    writeBuild(npmProducts(), 'Old_iphoneos26.0-arm64.xctestrun', new Date(Date.now() - 60_000));
    const newest = writeBuild(npmProducts(), XCTESTRUN, new Date());
    expect(findDeviceXctestrun(tmp)).toBe(newest);
  });

  it('returns undefined when nothing is built anywhere', () => {
    expect(findDeviceXctestrun(tmp)).toBeUndefined();
  });
});

// ─── Staleness and the not-found message ───

describe('staleNpmDeviceBuild / describeMissingDeviceXctestrun', () => {
  it('reports an npm build from another version, with both versions', () => {
    writeMarker('0.0.1-old');
    writeBuild(npmProducts());
    expect(staleNpmDeviceBuild()).toEqual({ builtBy: '0.0.1-old', current: tapsmithPackageVersion() });
    const msg = describeMissingDeviceXctestrun(path.join(tmp, 'proj'));
    expect(msg).toContain('built by Tapsmith 0.0.1-old');
    expect(msg).toContain(`this is ${tapsmithPackageVersion()}`);
    // Names the version to build with, so a second installed Tapsmith does not loop (R1-F7).
    expect(msg).toContain(`Rebuild it with Tapsmith ${tapsmithPackageVersion()}: run \`npx tapsmith ios build-agent\` in your project`);
  });

  it('is not stale when the npm build matches this version, or when there is no npm build', () => {
    expect(staleNpmDeviceBuild()).toBeUndefined();
    writeMarker(tapsmithPackageVersion());
    writeBuild(npmProducts());
    expect(staleNpmDeviceBuild()).toBeUndefined();
  });

  it('a version marker with no device build is not a stale build (simulator-only use)', () => {
    writeMarker('0.0.1-old');
    expect(staleNpmDeviceBuild()).toBeUndefined();
  });

  it('with nothing built, names both places it looked and the command to run', () => {
    const msg = describeMissingDeviceXctestrun(path.join(tmp, 'proj'));
    expect(msg).toMatch(/^No device xctestrun found/);
    expect(msg).toContain('ios-agent/.build-device');
    expect(msg).toContain(path.join(tmp, 'proj'));
    expect(msg).toContain('~/.tapsmith/ios-agent/.build-device');
    expect(msg).toContain('tapsmith ios build-agent');
    expect(msg).toContain('iosXctestrun');
  });
});

// ─── Hand-set xctestrun paths ───

describe('describeMissingExplicitXctestrun / staleExplicitXctestrunWarning', () => {
  it('a missing path in the npm agent directory blames the upgrade and says to rebuild', () => {
    const msg = describeMissingExplicitXctestrun(path.join(npmProducts(), XCTESTRUN), '`iosXctestrun`');
    expect(msg).toContain(`does not exist: ~/.tapsmith/ios-agent/.build-device/Build/Products/${XCTESTRUN}`);
    expect(msg).toContain('Upgrading Tapsmith replaces ~/.tapsmith/ios-agent');
    expect(msg).toContain('`npx tapsmith ios build-agent` in your project');
  });

  it('a missing path elsewhere says to fix or unset it', () => {
    const msg = describeMissingExplicitXctestrun('/somewhere/A.xctestrun', 'TAPSMITH_IOS_XCTESTRUN');
    expect(msg).toBe('The xctestrun set by TAPSMITH_IOS_XCTESTRUN does not exist: /somewhere/A.xctestrun. '
      + 'Fix the path, or unset it to let Tapsmith find the agent build itself.');
  });

  it('warns about an existing npm-directory build from another version, and only that', () => {
    const built = writeBuild(npmProducts());
    writeMarker('0.0.1-old');
    expect(staleExplicitXctestrunWarning(built)).toMatch(/built by Tapsmith 0\.0\.1-old .*tapsmith ios build-agent/);
    writeMarker(tapsmithPackageVersion());
    expect(staleExplicitXctestrunWarning(built)).toBeUndefined();
    expect(staleExplicitXctestrunWarning(path.join(tmp, 'elsewhere.xctestrun'))).toBeUndefined();
  });
});
