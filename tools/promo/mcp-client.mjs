// Scripted MCP client for the promo recording: connects to the UI-mode MCP
// server presenting itself as Claude Code, then executes tool calls on
// command from the recorder (lines on stdin), reporting completion on stdout.
import { createRequire } from 'node:module';
import * as readline from 'node:readline';

const require = createRequire('/Users/samsmithredbadger/projects/tapsmith/packages/tapsmith/package.json');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const MCP_URL = process.env.MCP_URL || 'http://localhost:9274/mcp';
const TEST_FILE = '/Users/samsmithredbadger/projects/tapsmith/e2e/tests/api-error.test.ts';

const client = new Client({ name: 'claude-code', version: '2.1.14' }, { capabilities: {} });
console.log('ready');

const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  const cmd = line.trim();
  try {
    if (cmd === 'connect') {
      await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL)));
      console.log('connected');
    } else if (cmd === 'list') {
      await client.callTool({ name: 'tapsmith_list_tests', arguments: {} });
      console.log('done:list');
    } else if (cmd === 'run') {
      const r = await client.callTool(
        { name: 'tapsmith_run_tests', arguments: { files: [TEST_FILE] } },
        undefined,
        { timeout: 300000, resetTimeoutOnProgress: true },
      );
      console.log('done:run', JSON.stringify(r.content?.[0]?.text ?? '').slice(0, 400));
    } else if (cmd === 'shot') {
      await client.callTool({ name: 'tapsmith_screenshot', arguments: {} });
      console.log('done:shot');
    } else if (cmd === 'quit') {
      break;
    }
  } catch (err) {
    console.log(`error:${cmd}`, String(err && err.message || err).slice(0, 200));
  }
}
await client.close();
process.exit(0);
