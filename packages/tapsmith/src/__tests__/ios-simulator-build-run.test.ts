/**
 * buildSimulatorAgent() against a real child process: a fake `xcodebuild`
 * shell script on PATH stands in for Xcode, so output size, exit codes,
 * signals and timeouts behave exactly as they would for the real tool
 * (PILOT-393: a buffered build was killed by ENOBUFS and reported without a
 * reason).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../build-ios-agent.js', () => ({
  resolveIosAgentDir: () => process.env.FAKE_AGENT_DIR,
  stripDstRootPath: () => undefined,
}));

// No existing build, and a detectable SDK: ensureSimulatorAgent() builds.
vi.mock('../ios-device-resolve.js', () => ({
  findSimulatorXctestrun: () => undefined,
  getInstalledSimulatorSdkVersion: () => '27.0',
  extractSdkVersion: () => undefined,
}));

const XCTESTRUN = 'TapsmithAgentUITests_TapsmithAgentUITests_iphonesimulator27.0-arm64.xctestrun';

const FAKE_XCODEBUILD = `#!/bin/sh
dd=""
while [ $# -gt 0 ]; do
  case "$1" in -derivedDataPath) dd="$2"; shift;; esac
  shift
done
products() {
  mkdir -p "$dd/Build/Products/Debug-iphonesimulator/TapsmithAgentUITests-Runner.app"
  touch "$dd/Build/Products/${XCTESTRUN}"
}
case "$FAKE_XCB_MODE" in
  big-ok)
    # 12 MB: over both the old 1 MB (init) and 10 MB (runtime) buffers.
    yes 'CompileSwift normal arm64 /a/fairly/long/path/to/TapsmithAgent/Source.swift (in target TapsmithAgentUITests)' | head -c 12000000
    echo
    echo 'some warning on stderr' >&2
    products
    echo '** TEST BUILD SUCCEEDED **'
    exit 0;;
  fail)
    i=0; while [ $i -lt 500 ]; do echo "CompileSwift line $i"; i=$((i+1)); done
    echo "/src/Agent.swift:12:5: error: cannot find 'foo' in scope"
    echo "/src/Agent.swift:20:1: error: expected declaration"
    i=0; while [ $i -lt 50 ]; do echo "trailing noise $i"; i=$((i+1)); done
    echo '** TEST BUILD FAILED **'
    exit 65;;
  fail-noerr)
    i=0; while [ $i -lt 100 ]; do echo "plain line $i"; i=$((i+1)); done
    echo 'last line before exit' >&2
    exit 1;;
  signal)
    echo 'about to be killed'
    kill -KILL $$;;
  sleep)
    echo 'hanging'
    exec sleep 30;;
esac
`;

let root: string;
let home: string;
let fakeBin: string;
const saved = { HOME: process.env.HOME, PATH: process.env.PATH };

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-xcb-test-'));
  fakeBin = path.join(root, 'bin');
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, 'xcodebuild'), FAKE_XCODEBUILD, { mode: 0o755 });
  const agentDir = path.join(root, 'ios-agent');
  fs.mkdirSync(path.join(agentDir, 'TapsmithAgent.xcodeproj'), { recursive: true });
  process.env.FAKE_AGENT_DIR = agentDir;
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.FAKE_AGENT_DIR;
});

beforeEach(() => {
  vi.resetModules();
  home = fs.mkdtempSync(path.join(root, 'home-'));
  process.env.HOME = home;
  process.env.PATH = `${fakeBin}${path.delimiter}${saved.PATH ?? ''}`;
});

afterEach(() => {
  process.env.HOME = saved.HOME;
  process.env.PATH = saved.PATH;
  delete process.env.FAKE_XCB_MODE;
});

const cacheDir = (): string => path.join(home, '.tapsmith', 'ios-simulator-agent');
const logPath = (): string => path.join(cacheDir(), 'xcodebuild.log');

async function build(mode: string, options?: { timeoutMs?: number }): Promise<string> {
  process.env.FAKE_XCB_MODE = mode;
  const { buildSimulatorAgent } = await import('../ios-simulator-build.js');
  return buildSimulatorAgent('27.0', options);
}

async function buildError(mode: string, options?: { timeoutMs?: number }): Promise<string> {
  return build(mode, options).then(
    () => { throw new Error('expected the build to fail'); },
    (err: unknown) => (err as Error).message,
  );
}

describe('buildSimulatorAgent() xcodebuild output handling', () => {
  it('succeeds when xcodebuild prints more output than any buffer would hold', async () => {
    const xctestrun = await build('big-ok');
    expect(xctestrun).toBe(path.join(cacheDir(), XCTESTRUN));
    expect(fs.readFileSync(path.join(cacheDir(), '.sdk-version'), 'utf8')).toBe('27.0');
    // The whole stream went to the log, not to memory.
    const log = fs.readFileSync(logPath(), 'utf8');
    expect(log.length).toBeGreaterThan(12_000_000);
    expect(log).toContain('** TEST BUILD SUCCEEDED **');
    expect(log).toContain('some warning on stderr');
  }, 30_000);

  it('names the exit code, shows the error lines and points at the log', async () => {
    const message = await buildError('fail');
    expect(message).toContain('xcodebuild build-for-testing failed (exit code 65)');
    expect(message).toContain("/src/Agent.swift:12:5: error: cannot find 'foo' in scope");
    expect(message).toContain('/src/Agent.swift:20:1: error: expected declaration');
    expect(message).not.toContain('CompileSwift line 3');
    expect(message).toContain(`Full build log: ${logPath()}`);
    expect(fs.readFileSync(logPath(), 'utf8')).toContain('CompileSwift line 499');
    // The daemon's agent-launch text: classified as retryable infrastructure.
    expect(message).not.toContain('xcodebuild exited with');
    // A failed build leaves no SDK marker, so it is never taken as cached.
    expect(fs.existsSync(path.join(cacheDir(), '.sdk-version'))).toBe(false);
  });

  it('falls back to the last lines when the output has no error: lines', async () => {
    const message = await buildError('fail-noerr');
    expect(message).toContain('failed (exit code 1)');
    expect(message).toContain('last line before exit');
    expect(message).toContain('plain line 99');
    expect(message).not.toContain('plain line 10\n');
    expect(message.split('\n').length).toBeLessThan(30);
  });

  it('names the signal when xcodebuild is killed', async () => {
    const message = await buildError('signal');
    expect(message).toContain('xcodebuild build-for-testing was killed by SIGKILL');
    expect(message).toContain('about to be killed');
    expect(message).not.toContain('xcodebuild exited with');
    expect(message).toContain(`Full build log: ${logPath()}`);
  });

  it('stops a build that outlives its timeout and says so', async () => {
    const started = Date.now();
    const message = await buildError('sleep', { timeoutMs: 300 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(message).toContain('xcodebuild build-for-testing timed out after 0.3s and was stopped');
    expect(message).toContain('hanging');
  });

  it('says xcodebuild could not start when it is not installed', async () => {
    process.env.PATH = path.join(root, 'empty-bin');
    const message = await buildError('big-ok');
    expect(message).toMatch(/could not start xcodebuild: .*ENOENT/);
  });
});

describe('ensureSimulatorAgent() options', () => {
  it('quiet keeps stdout clean while it builds', async () => {
    process.env.FAKE_XCB_MODE = 'big-ok';
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const write = vi.spyOn(process.stdout, 'write');
    try {
      const { ensureSimulatorAgent } = await import('../ios-simulator-build.js');
      expect(await ensureSimulatorAgent({ quiet: true })).toBe(path.join(cacheDir(), XCTESTRUN));
      expect(log).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      write.mockRestore();
    }
  }, 30_000);

  it('reports its progress line by default', async () => {
    process.env.FAKE_XCB_MODE = 'big-ok';
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const { ensureSimulatorAgent } = await import('../ios-simulator-build.js');
      await ensureSimulatorAgent();
      expect(log).toHaveBeenCalledWith(expect.stringContaining('Building from source for SDK 27.0'));
    } finally {
      log.mockRestore();
    }
  }, 30_000);

  it('passes its timeout to the build and names the build failure', async () => {
    process.env.FAKE_XCB_MODE = 'sleep';
    const { ensureSimulatorAgent } = await import('../ios-simulator-build.js');
    await expect(ensureSimulatorAgent({ quiet: true, timeoutMs: 300 })).rejects.toThrow(
      /^Failed to build iOS simulator agent from source: xcodebuild build-for-testing timed out after 0\.3s/,
    );
  });
});
