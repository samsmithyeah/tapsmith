import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registerListTestsTool } from '../mcp/tools/list-tests.js';
import {
  needsTsxLoader,
  resolveTsxBin,
  fileFailureEntry,
  resultEntryKey,
} from '../mcp/headless-dispatcher.js';
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
