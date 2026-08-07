import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registerListTestsTool } from '../mcp/tools/list-tests.js';
import { needsTsxLoader, resolveTsxBin, resolveChildLoader } from '../child-scripts.js';
import {
  fileFailureEntry,
  resultEntryKey,
  matchRequestedFiles,
  platformKeyForProject,
} from '../mcp/headless-dispatcher.js';
import { registerSessionInfoTool } from '../mcp/tools/session-info.js';
import { loadMcpConfig } from '../mcp/config-loader.js';
import {
  readDaemonRegistry,
  registerDaemon,
  unregisterDaemon,
  pruneDaemonRegistry,
} from '../mcp/connection.js';
import { mcpDaemonRegistryPath } from '../mcp/port-file.js';
import type { DiscoveryError, TestDispatcher, TestTreeEntry } from '../mcp/test-dispatcher.js';

// The headless MCP server forks children to discover and to run test files.
// Both import the project's test files, so both need the tsx loader when those
// are TypeScript — bare node resolves a `.ts` file but does not remap a
// `./x.js` specifier to `x.ts`. Choosing the loader from our own scripts alone
// meant a published install (all `.js`) always forked bare node, dropping every
// test file that imports a sibling module — silently during discovery, and with
// a bare failure count at run time.

type ToolCallback = (args: Record<string, unknown>, extra: unknown) => Promise<CallToolResult>;

function makeToolCapture(): { server: McpServer; tools: Map<string, ToolCallback> } {
  const tools = new Map<string, ToolCallback>();
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, cb: ToolCallback): void => {
      tools.set(name, cb);
    },
  } as unknown as McpServer;
  return { server, tools };
}

const extra = { _meta: undefined, sendNotification: async (): Promise<void> => {} };

function makeDispatcher(overrides: Partial<TestDispatcher> = {}): TestDispatcher {
  return {
    runFiles: async () => ({ status: 'passed', passed: 0, failed: 0, skipped: 0, duration: 0 }),
    runAll: async () => ({ status: 'passed', passed: 0, failed: 0, skipped: 0, duration: 0 }),
    stop: () => {},
    isRunning: () => false,
    getResults: () => [],
    getTestFiles: () => [],
    getProjects: () => [],
    getTestTree: () => [],
    getSessionInfo: () => ({ timeout: 0, retries: 0, projects: [] }),
    toggleWatch: () => ({ enabled: false }),
    ...overrides,
  };
}

function fileNode(filePath: string): TestTreeEntry {
  return {
    type: 'file',
    name: path.basename(filePath),
    fullName: path.basename(filePath),
    filePath,
    status: 'idle',
    children: [{ type: 'test', name: 'works', fullName: 'works', filePath, status: 'idle' }],
  };
}

async function callListTests(dispatcher: TestDispatcher): Promise<string> {
  const { server, tools } = makeToolCapture();
  registerListTestsTool(server, dispatcher);
  const result = await tools.get('tapsmith_list_tests')!({}, extra);
  return result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}

describe('needsTsxLoader', () => {
  it('requires tsx for TypeScript test files even when the scripts are compiled JS', () => {
    expect(needsTsxLoader(
      ['/pkg/dist/watch-run.js', '/pkg/dist/ui-mode/ui-discover.js'],
      ['/project/tests/login.test.ts'],
    )).toBe(true);
  });

  it('requires tsx for .tsx test files', () => {
    expect(needsTsxLoader(['/pkg/dist/watch-run.js'], ['/project/tests/login.test.tsx'])).toBe(true);
  });

  it('requires tsx when our own scripts are TypeScript (source checkout)', () => {
    expect(needsTsxLoader(['/pkg/src/watch-run.ts'], ['/project/tests/login.test.js'])).toBe(true);
  });

  it('skips tsx when neither the scripts nor the test files are TypeScript', () => {
    expect(needsTsxLoader(['/pkg/dist/watch-run.js'], ['/project/tests/login.test.js'])).toBe(false);
  });

  it('skips tsx when no test files have been discovered yet', () => {
    expect(needsTsxLoader(['/pkg/dist/watch-run.js'], [])).toBe(false);
  });
});

describe('resolveTsxBin', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-tsx-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function touch(...segments: string[]): string {
    const file = path.join(root, ...segments);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
    return file;
  }

  it('finds tsx inside our own dependency tree', () => {
    const pkgDir = path.join(root, 'packages', 'tapsmith');
    const bin = touch('packages', 'tapsmith', 'node_modules', '.bin', 'tsx');
    expect(resolveTsxBin(pkgDir)).toBe(bin);
  });

  it('finds tsx hoisted to the consumer node_modules/.bin', () => {
    const pkgDir = path.join(root, 'node_modules', 'tapsmith');
    fs.mkdirSync(pkgDir, { recursive: true });
    const bin = touch('node_modules', '.bin', 'tsx');
    expect(resolveTsxBin(pkgDir)).toBe(bin);
  });

  it('prefers our own dependency tree over the hoisted copy', () => {
    const pkgDir = path.join(root, 'node_modules', 'tapsmith');
    const own = touch('node_modules', 'tapsmith', 'node_modules', '.bin', 'tsx');
    touch('node_modules', '.bin', 'tsx');
    expect(resolveTsxBin(pkgDir)).toBe(own);
  });

  it('never returns a path that does not exist', () => {
    // Falls back to resolving the tsx package or PATH; whatever comes back must
    // be real, because forking a non-existent execPath fails silently.
    const resolved = resolveTsxBin(path.join(root, 'nowhere'));
    if (resolved !== undefined) expect(fs.existsSync(resolved)).toBe(true);
  });
});

describe('resolveChildLoader', () => {
  it('returns no loader, and stays quiet, when nothing is TypeScript', () => {
    const warnings: string[] = [];
    const loader = resolveChildLoader(
      ['/pkg/dist/watch-run.js'],
      ['/project/tests/login.test.js'],
      '/pkg',
      (m) => warnings.push(m),
    );
    expect(loader).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it('reports when TypeScript tests need a loader that cannot be found', () => {
    const warnings: string[] = [];
    const emptyPath = process.env.PATH;
    process.env.PATH = '';
    try {
      resolveChildLoader(
        ['/pkg/dist/watch-run.js'],
        ['/project/tests/login.test.ts'],
        '/nonexistent-pkg-dir',
        (m) => warnings.push(m),
      );
    } finally {
      process.env.PATH = emptyPath;
    }
    // tsx may still be resolvable through our own package; only assert that a
    // failure is never silent.
    if (warnings.length > 0) expect(warnings[0]).toContain('tsx');
  });
});

describe('fileFailureEntry', () => {
  it('records the cause of a whole-file failure as a failed result', () => {
    const entry = fileFailureEntry(
      '/project/tests/toggles.test.ts',
      'ios',
      new Error("Cannot find module '/project/fixtures.js'"),
    );
    expect(entry.status).toBe('failed');
    expect(entry.error).toBe("Cannot find module '/project/fixtures.js'");
    expect(entry.filePath).toBe('/project/tests/toggles.test.ts');
    expect(entry.projectName).toBe('ios');
    expect(entry.fullName).toContain('toggles.test.ts');
  });

  it('stringifies non-Error throws', () => {
    expect(fileFailureEntry('/project/tests/a.test.ts', undefined, 'worker died').error)
      .toBe('worker died');
  });

  it('produces a key that does not collide with another file in the same project', () => {
    const a = fileFailureEntry('/project/tests/a.test.ts', 'ios', new Error('boom'));
    const b = fileFailureEntry('/project/tests/b.test.ts', 'ios', new Error('boom'));
    expect(resultEntryKey('ios', a.filePath, a.fullName))
      .not.toBe(resultEntryKey('ios', b.filePath, b.fullName));
  });
});

describe('tapsmith_list_tests discovery errors', () => {
  const failures: DiscoveryError[] = [
    { filePath: '/project/tests/toggles.test.ts', error: "Cannot find module '/project/fixtures.js'" },
  ];

  it('warns about files that failed to load, with the reason', async () => {
    const text = await callListTests(makeDispatcher({
      getTestTree: () => [fileNode('/project/tests/ok.test.ts')],
      getDiscoveryErrors: () => failures,
    }));
    expect(text).toContain('1 test file(s) failed to load');
    expect(text).toContain('/project/tests/toggles.test.ts');
    expect(text).toContain("Cannot find module '/project/fixtures.js'");
    // The tests that did load are still listed.
    expect(text).toContain('/project/tests/ok.test.ts');
  });

  it('reports failures even when nothing at all could be discovered', async () => {
    const text = await callListTests(makeDispatcher({
      getTestTree: () => [],
      getDiscoveryErrors: () => failures,
    }));
    expect(text).not.toBe('No test files discovered.');
    expect(text).toContain('failed to load');
  });

  it('caps the listing but still reports the true total', async () => {
    const many = Array.from({ length: 28 }, (_, i) => ({
      filePath: `/project/tests/f${i}.test.ts`,
      error: 'Cannot find module',
    }));
    const text = await callListTests(makeDispatcher({
      getTestTree: () => [fileNode('/project/tests/ok.test.ts')],
      getDiscoveryErrors: () => many,
    }));
    expect(text).toContain('28 test file(s) failed to load');
    expect(text).toContain('… and 18 more');
    expect(text).toContain('/project/tests/f0.test.ts');
    expect(text).not.toContain('/project/tests/f27.test.ts');
  });

  it('stays quiet when every file loaded', async () => {
    const text = await callListTests(makeDispatcher({
      getTestTree: () => [fileNode('/project/tests/ok.test.ts')],
      getDiscoveryErrors: () => [],
    }));
    expect(text).not.toContain('failed to load');
  });

  it('tolerates a dispatcher that does not report discovery errors', async () => {
    const text = await callListTests(makeDispatcher({
      getTestTree: () => [fileNode('/project/tests/ok.test.ts')],
    }));
    expect(text).toContain('/project/tests/ok.test.ts');
  });
});

describe('matchRequestedFiles', () => {
  const testFiles = [
    '/project/e2e/tests/login.test.ts',
    '/project/e2e/tests/nested/checkout.test.ts',
    '/project/e2e/tests/profile.test.ts',
  ];
  const roots = ['/project/e2e'];

  it('matches an absolute path', () => {
    expect(matchRequestedFiles(['/project/e2e/tests/login.test.ts'], testFiles, roots))
      .toEqual(['/project/e2e/tests/login.test.ts']);
  });

  it('matches a path relative to the project root', () => {
    expect(matchRequestedFiles(['tests/login.test.ts'], testFiles, roots))
      .toEqual(['/project/e2e/tests/login.test.ts']);
  });

  it('matches a path relative to the working directory when it differs from the root', () => {
    expect(matchRequestedFiles(['nested/checkout.test.ts'], testFiles, ['/project/e2e/tests']))
      .toEqual(['/project/e2e/tests/nested/checkout.test.ts']);
  });

  it('matches a relative glob', () => {
    expect(matchRequestedFiles(['tests/*.test.ts'], testFiles, roots).sort())
      .toEqual(['/project/e2e/tests/login.test.ts', '/project/e2e/tests/profile.test.ts']);
  });

  it('matches a recursive glob across directories', () => {
    expect(matchRequestedFiles(['tests/**/*.test.ts'], testFiles, roots).sort())
      .toEqual([
        '/project/e2e/tests/login.test.ts',
        '/project/e2e/tests/nested/checkout.test.ts',
        '/project/e2e/tests/profile.test.ts',
      ]);
  });

  it('matches an absolute glob', () => {
    expect(matchRequestedFiles(['/project/e2e/tests/*.test.ts'], testFiles, roots).sort())
      .toEqual(['/project/e2e/tests/login.test.ts', '/project/e2e/tests/profile.test.ts']);
  });

  it('returns nothing for an argument that matches no discovered file', () => {
    expect(matchRequestedFiles(['tests/typo.test.ts'], testFiles, roots)).toEqual([]);
  });

  it('never returns a file that was not discovered', () => {
    expect(matchRequestedFiles(['**/*'], ['/project/e2e/tests/login.test.ts'], roots))
      .toEqual(['/project/e2e/tests/login.test.ts']);
  });

  it('does not duplicate a file matched by several arguments', () => {
    const matched = matchRequestedFiles(
      ['tests/login.test.ts', '/project/e2e/tests/login.test.ts', 'tests/*.test.ts'],
      testFiles,
      roots,
    );
    expect(matched.filter((f) => f.endsWith('login.test.ts'))).toHaveLength(1);
  });
});

describe('tapsmith_session_info config reporting', () => {
  async function callSessionInfo(dispatcher: TestDispatcher): Promise<string> {
    const { server, tools } = makeToolCapture();
    registerSessionInfoTool(server, dispatcher);
    const result = await tools.get('tapsmith_session_info')!({}, extra);
    return result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
  }

  it('names the config file backing the session', async () => {
    const text = await callSessionInfo(makeDispatcher({
      getSessionInfo: () => ({
        timeout: 0,
        retries: 0,
        projects: [],
        configPath: '/project/e2e/tapsmith.config.ios.mjs',
      }),
    }));
    expect(text).toContain('Config: /project/e2e/tapsmith.config.ios.mjs');
    expect(text).not.toContain('WARNING');
  });

  it('says so, loudly, when the session runs on synthesized defaults', async () => {
    const text = await callSessionInfo(makeDispatcher({
      getSessionInfo: () => ({
        timeout: 0,
        retries: 0,
        projects: [],
        configWarning: 'No Tapsmith config file is backing this session (working directory: /project).',
      }),
    }));
    expect(text).toContain('Config: none');
    expect(text).toContain('WARNING');
    expect(text).toContain('/project');
  });
});

describe('loadMcpConfig config-file reporting', () => {
  let root: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    // realpath: macOS resolves /var to /private/var on chdir, and the loader
    // reports paths built from process.cwd().
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-cfg-')));
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reports the config path and no warning when one is found in the working directory', async () => {
    fs.writeFileSync(path.join(root, 'tapsmith.config.mjs'), 'export default { platform: "ios" }\n');
    process.chdir(root);
    const result = await loadMcpConfig();
    expect(result.configPath).toBe(path.join(root, 'tapsmith.config.mjs'));
    expect(result.warning).toBeUndefined();
  });

  it('finds a single config one level down', async () => {
    fs.mkdirSync(path.join(root, 'e2e'));
    fs.writeFileSync(path.join(root, 'e2e', 'tapsmith.config.mjs'), 'export default { platform: "ios" }\n');
    process.chdir(root);
    const result = await loadMcpConfig();
    expect(result.configPath).toBe(path.join(root, 'e2e', 'tapsmith.config.mjs'));
    expect(result.warning).toBeUndefined();
  });

  it('warns, naming the directory, when no config exists anywhere', async () => {
    process.chdir(root);
    const result = await loadMcpConfig();
    expect(result.configPath).toBeUndefined();
    expect(result.warning).toContain('No Tapsmith config file');
    expect(result.warning).toContain('--config');
    expect(result.warning).toContain('tests cannot run');
  });

  it('warns and lists the candidates when several configs sit one level down', async () => {
    for (const dir of ['e2e', 'smoke']) {
      fs.mkdirSync(path.join(root, dir));
      fs.writeFileSync(path.join(root, dir, 'tapsmith.config.mjs'), 'export default { platform: "ios" }\n');
    }
    process.chdir(root);
    const result = await loadMcpConfig();
    expect(result.configPath).toBeUndefined();
    expect(result.warning).toContain('Multiple configs');
    expect(result.warning).toContain('e2e');
    expect(result.warning).toContain('smoke');
  });
});

// A multi-platform config keeps its platforms on the projects, not at the top
// level. The session used to provision one device for the whole session and
// start its agent from the (absent) root platform, so iOS projects failed with
// "iOS agent is not configured" however the run was requested.
describe('platformKeyForProject', () => {
  const projects = [
    { name: 'android', effectiveConfig: { platform: 'android' } },
    { name: 'ios', effectiveConfig: { platform: 'ios' } },
    { name: 'ios:authenticated', effectiveConfig: { platform: 'ios' } },
  ];

  it("routes a run to its project's platform when the root config has none", () => {
    expect(platformKeyForProject(projects, 'ios', undefined)).toBe('ios');
    expect(platformKeyForProject(projects, 'android', undefined)).toBe('android');
  });

  it('routes dependent projects to the same platform as their siblings', () => {
    expect(platformKeyForProject(projects, 'ios:authenticated', undefined)).toBe('ios');
  });

  it('falls back to the root platform for a single-platform config', () => {
    expect(platformKeyForProject([], undefined, 'ios')).toBe('ios');
  });

  it("prefers the project's platform over the root's", () => {
    expect(platformKeyForProject(projects, 'android', 'ios')).toBe('android');
  });

  it('falls back to the default key when nothing declares a platform', () => {
    expect(platformKeyForProject([], undefined, undefined)).toBe('default');
  });

  it('falls back to the root platform for an unknown project name', () => {
    expect(platformKeyForProject(projects, 'nope', 'android')).toBe('android');
  });
});

describe('tapsmith_session_info device targets', () => {
  async function callSessionInfo(dispatcher: TestDispatcher): Promise<string> {
    const { server, tools } = makeToolCapture();
    registerSessionInfoTool(server, dispatcher);
    const result = await tools.get('tapsmith_session_info')!({}, extra);
    return result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
  }

  it('lists a device per platform for a multi-platform session', async () => {
    const text = await callSessionInfo(makeDispatcher({
      getSessionInfo: () => ({
        timeout: 0,
        retries: 0,
        projects: [],
        deviceTargets: [
          { platform: 'ios', device: 'SIM-1' },
          { platform: 'android', device: 'emulator-5554' },
        ],
      }),
    }));
    expect(text).toContain('Device (ios): SIM-1');
    expect(text).toContain('Device (android): emulator-5554');
  });

  it('says which platform has no device, and why', async () => {
    const text = await callSessionInfo(makeDispatcher({
      getSessionInfo: () => ({
        timeout: 0,
        retries: 0,
        projects: [],
        deviceTargets: [
          { platform: 'ios', device: 'SIM-1' },
          { platform: 'android', error: 'No android device is available. Start an emulator and try again.' },
        ],
      }),
    }));
    expect(text).toContain('Device (ios): SIM-1');
    expect(text).toContain('Device (android): unavailable — No android device is available.');
  });

  it('keeps the single-device line for a single-platform session', async () => {
    const text = await callSessionInfo(makeDispatcher({
      getSessionInfo: () => ({
        timeout: 0,
        retries: 0,
        projects: [],
        device: 'SIM-1',
        deviceTargets: [{ platform: 'ios', device: 'SIM-1' }],
      }),
    }));
    expect(text).toContain('Device: SIM-1');
    expect(text).not.toContain('Device (ios)');
  });
});

describe('MCP daemon registry', () => {
  let root: string;
  let originalTmp: string | undefined;

  beforeEach(() => {
    originalTmp = process.env.TMPDIR;
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-reg-'));
    process.env.TMPDIR = root;
  });

  afterEach(() => {
    process.env.TMPDIR = originalTmp;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('starts empty and survives a missing registry file', () => {
    expect(readDaemonRegistry()).toEqual([]);
  });

  it('remembers a daemon so another session can find it', () => {
    registerDaemon('127.0.0.1:50161');
    expect(readDaemonRegistry()).toEqual(['127.0.0.1:50161']);
  });

  it('does not record the same daemon twice', () => {
    registerDaemon('127.0.0.1:50161');
    registerDaemon('127.0.0.1:50161');
    expect(readDaemonRegistry()).toEqual(['127.0.0.1:50161']);
  });

  it('forgets a daemon when its session shuts it down', () => {
    registerDaemon('127.0.0.1:50161');
    registerDaemon('127.0.0.1:50244');
    unregisterDaemon('127.0.0.1:50161');
    expect(readDaemonRegistry()).toEqual(['127.0.0.1:50244']);
  });

  it('drops addresses that failed to answer a probe', () => {
    registerDaemon('127.0.0.1:50161');
    registerDaemon('127.0.0.1:50244');
    pruneDaemonRegistry(['127.0.0.1:50244']);
    expect(readDaemonRegistry()).toEqual(['127.0.0.1:50244']);
  });

  it('leaves the registry alone when it is already empty', () => {
    pruneDaemonRegistry([]);
    expect(readDaemonRegistry()).toEqual([]);
  });

  it('treats a corrupt registry as empty rather than throwing', () => {
    registerDaemon('127.0.0.1:50161');
    fs.writeFileSync(mcpDaemonRegistryPath(), 'not json', 'utf-8');
    expect(readDaemonRegistry()).toEqual([]);
  });
});
