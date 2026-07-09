import { describe, it, expect } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { registerSuiteStatusTool } from '../mcp/tools/suite-status.js';
import { registerRunTestsTool } from '../mcp/tools/run-tests.js';
import type { TestDispatcher, TestResultEntry, TestTreeEntry } from '../mcp/test-dispatcher.js';

// PILOT-286: tapsmith_suite_status joins the discovered test tree with results
// accumulated across every run in the session, so batched runs build a
// complete passed/failed/skipped/not-run board instead of only the last run.

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

function testNode(filePath: string, fullName: string): TestTreeEntry {
  return { type: 'test', name: fullName.split(' > ').pop()!, fullName, filePath, status: 'idle' };
}

function fileNode(filePath: string, tests: TestTreeEntry[]): TestTreeEntry {
  return { type: 'file', name: filePath, fullName: filePath, filePath, status: 'idle', children: tests };
}

function projectNode(name: string, children: TestTreeEntry[]): TestTreeEntry {
  return { type: 'project', name, fullName: name, filePath: '', status: 'idle', children };
}

function result(
  filePath: string,
  fullName: string,
  status: TestResultEntry['status'],
  extras: Partial<TestResultEntry> = {},
): TestResultEntry {
  return { fullName, filePath, status, ...extras };
}

function textOf(callResult: CallToolResult): string {
  return (callResult.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => (c as { text: string }).text)
    .join('\n');
}

describe('tapsmith_suite_status', () => {
  it('reports every discovered test as passed, failed, skipped, or not run', async () => {
    const tree = [
      fileNode('/app/a.test.ts', [
        testNode('/app/a.test.ts', 'auth > logs in'),
        testNode('/app/a.test.ts', 'auth > logs out'),
      ]),
      fileNode('/app/b.test.ts', [testNode('/app/b.test.ts', 'cart > adds item')]),
    ];
    const dispatcher = makeDispatcher({
      getTestTree: () => tree,
      getResults: () => [
        result('/app/a.test.ts', 'auth > logs in', 'passed'),
        result('/app/a.test.ts', 'auth > logs out', 'failed', { error: 'boom' }),
      ],
    });

    const { server, tools } = makeToolCapture();
    registerSuiteStatusTool(server, dispatcher);
    const text = textOf(await tools.get('tapsmith_suite_status')!({}, extra));

    expect(text).toContain('Suite status: 1 passed, 1 failed, 0 skipped, 1 not run (2/3 tests run)');
    expect(text).toContain('/app/a.test.ts: 1 passed, 1 failed');
    expect(text).toContain('FAIL: auth > logs out — boom');
    expect(text).toContain('/app/b.test.ts: 1 not run');
  });

  it('accumulates results across batched run_tests calls', async () => {
    const tree = [
      fileNode('/app/a.test.ts', [testNode('/app/a.test.ts', 'auth > logs in')]),
      fileNode('/app/b.test.ts', [testNode('/app/b.test.ts', 'cart > adds item')]),
      fileNode('/app/c.test.ts', [testNode('/app/c.test.ts', 'search > finds item')]),
    ];
    // Simulates the dispatcher's reset-per-run behaviour: getResults() only
    // ever returns the most recent batch.
    let currentResults: TestResultEntry[] = [];
    const dispatcher = makeDispatcher({
      getTestTree: () => tree,
      getResults: () => currentResults,
      runFiles: async (files: string[]) => {
        currentResults = files.includes('/app/a.test.ts')
          ? [result('/app/a.test.ts', 'auth > logs in', 'passed')]
          : [result('/app/b.test.ts', 'cart > adds item', 'failed', { error: 'nope' })];
        return { status: 'passed', passed: 1, failed: 0, skipped: 0, duration: 1 };
      },
    });

    const { server, tools } = makeToolCapture();
    registerRunTestsTool(server, dispatcher);
    registerSuiteStatusTool(server, dispatcher);
    const runTests = tools.get('tapsmith_run_tests')!;
    const suiteStatus = tools.get('tapsmith_suite_status')!;

    await runTests({ files: ['/app/a.test.ts'] }, extra);
    await runTests({ files: ['/app/b.test.ts'] }, extra);

    const text = textOf(await suiteStatus({}, extra));
    // Batch 1's pass survives batch 2 replacing the dispatcher's results.
    expect(text).toContain('Suite status: 1 passed, 1 failed, 0 skipped, 1 not run (2/3 tests run)');
    expect(text).toContain('/app/a.test.ts: 1 passed');
    expect(text).toContain('/app/b.test.ts: 1 failed');
    expect(text).toContain('/app/c.test.ts: 1 not run');
  });

  it('captures results from runs it never saw start (read-time merge)', async () => {
    const tree = [fileNode('/app/a.test.ts', [testNode('/app/a.test.ts', 'auth > logs in')])];
    const dispatcher = makeDispatcher({
      getTestTree: () => tree,
      // e.g. a run triggered from the UI, not through tapsmith_run_tests
      getResults: () => [result('/app/a.test.ts', 'auth > logs in', 'passed')],
    });

    const { server, tools } = makeToolCapture();
    registerSuiteStatusTool(server, dispatcher);
    const text = textOf(await tools.get('tapsmith_suite_status')!({}, extra));

    expect(text).toContain('Suite status: 1 passed, 0 failed, 0 skipped, 0 not run (1/1 tests run)');
  });

  it('joins project-grouped trees using the project name', async () => {
    const tree = [
      projectNode('android', [fileNode('/app/a.test.ts', [testNode('/app/a.test.ts', 'auth > logs in')])]),
      projectNode('ios', [fileNode('/app/a.test.ts', [testNode('/app/a.test.ts', 'auth > logs in')])]),
    ];
    const dispatcher = makeDispatcher({
      getTestTree: () => tree,
      getResults: () => [
        result('/app/a.test.ts', 'auth > logs in', 'passed', { projectName: 'android' }),
      ],
    });

    const { server, tools } = makeToolCapture();
    registerSuiteStatusTool(server, dispatcher);
    const text = textOf(await tools.get('tapsmith_suite_status')!({}, extra));

    // Only the android run counts; the ios copy of the same test is not run.
    expect(text).toContain('Suite status: 1 passed, 0 failed, 0 skipped, 1 not run (1/2 tests run)');
    expect(text).toContain('/app/a.test.ts [android]: 1 passed');
    expect(text).toContain('/app/a.test.ts [ios]: 1 not run');
  });

  it("joins tests under a 'default' project node with results that have no projectName", async () => {
    // A config mixing named and unnamed projects produces a tree with a
    // project node literally named 'default', but the dispatchers record the
    // default project's results with projectName undefined. The join must
    // normalize or every default-project test shows as not run (seen live
    // against the e2e session's authentication/authenticated/default setup).
    const tree = [
      projectNode('default', [fileNode('/app/a.test.ts', [testNode('/app/a.test.ts', 'auth > logs in')])]),
      projectNode('authenticated', [fileNode('/app/b.test.ts', [testNode('/app/b.test.ts', 'cart > adds item')])]),
    ];
    const dispatcher = makeDispatcher({
      getTestTree: () => tree,
      getResults: () => [result('/app/a.test.ts', 'auth > logs in', 'passed')],
    });

    const { server, tools } = makeToolCapture();
    registerSuiteStatusTool(server, dispatcher);
    const text = textOf(await tools.get('tapsmith_suite_status')!({}, extra));

    expect(text).toContain('Suite status: 1 passed, 0 failed, 0 skipped, 1 not run (1/2 tests run)');
    expect(text).toContain('/app/a.test.ts: 1 passed');
    expect(text).toContain('/app/b.test.ts [authenticated]: 1 not run');
  });

  it('ignores in-flight (running/idle) statuses when merging', async () => {
    const tree = [
      fileNode('/app/a.test.ts', [
        testNode('/app/a.test.ts', 'auth > logs in'),
        testNode('/app/a.test.ts', 'auth > logs out'),
      ]),
    ];
    const dispatcher = makeDispatcher({
      getTestTree: () => tree,
      getResults: () => [
        result('/app/a.test.ts', 'auth > logs in', 'passed'),
        result('/app/a.test.ts', 'auth > logs out', 'running'),
      ],
      isRunning: () => true,
    });

    const { server, tools } = makeToolCapture();
    registerSuiteStatusTool(server, dispatcher);
    const text = textOf(await tools.get('tapsmith_suite_status')!({}, extra));

    expect(text).toContain('Suite status: 1 passed, 0 failed, 0 skipped, 1 not run (1/2 tests run)');
    expect(text).toContain('A test run is in progress');
  });

  it('supports the details flag and file filter', async () => {
    const tree = [
      fileNode('/app/a.test.ts', [
        testNode('/app/a.test.ts', 'auth > logs in'),
        testNode('/app/a.test.ts', 'auth > logs out'),
      ]),
      fileNode('/app/b.test.ts', [testNode('/app/b.test.ts', 'cart > adds item')]),
    ];
    const dispatcher = makeDispatcher({
      getTestTree: () => tree,
      getResults: () => [result('/app/a.test.ts', 'auth > logs in', 'passed')],
    });

    const { server, tools } = makeToolCapture();
    registerSuiteStatusTool(server, dispatcher);
    const suiteStatus = tools.get('tapsmith_suite_status')!;

    const detailed = textOf(await suiteStatus({ details: true, file: 'a.test.ts' }, extra));
    expect(detailed).toContain('[PASS] auth > logs in');
    expect(detailed).toContain('[ -- ] auth > logs out');
    expect(detailed).not.toContain('b.test.ts');
  });

  it('reports when no test files are discovered', async () => {
    const dispatcher = makeDispatcher();
    const { server, tools } = makeToolCapture();
    registerSuiteStatusTool(server, dispatcher);
    const text = textOf(await tools.get('tapsmith_suite_status')!({}, extra));
    expect(text).toBe('No test files discovered.');
  });
});
