import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { TestDispatcher } from '../test-dispatcher.js';

export function registerStopTestsTool(server: McpServer, dispatcher: TestDispatcher): void {
  server.tool(
    'pilot_stop_tests',
    'Stop the currently running test execution. Works whether the run was started by the agent or the user in the UI.',
    {},
    async () => {
      if (!dispatcher.isRunning()) {
        return { content: [{ type: 'text' as const, text: 'No test run is currently in progress.' }] };
      }
      dispatcher.stop();
      return { content: [{ type: 'text' as const, text: 'Stop signal sent. The running test will be terminated.' }] };
    },
  );
}
