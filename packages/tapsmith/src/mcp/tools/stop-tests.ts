import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { TestDispatcher } from '../test-dispatcher.js';

/** How long to wait for the run to actually end before reporting "still stopping". */
const STOP_WAIT_MS = 10_000;

export function registerStopTestsTool(server: McpServer, dispatcher: TestDispatcher): void {
  server.tool(
    'tapsmith_stop_tests',
    'Stop the currently running test execution and report the outcome. Works whether the run was started by the agent or the user in the UI.',
    {},
    async () => {
      if (!dispatcher.isRunning()) {
        return { content: [{ type: 'text' as const, text: 'No test run is currently in progress.' }] };
      }
      dispatcher.stop();

      const result = dispatcher.waitForRunEnd
        ? await dispatcher.waitForRunEnd(STOP_WAIT_MS)
        : null;

      if (result) {
        const interrupted = result.interrupted ? `, ${result.interrupted} interrupted` : '';
        return {
          content: [{
            type: 'text' as const,
            text: `Run stopped: ${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped${interrupted}. Use tapsmith_list_results for details.`,
          }],
        };
      }
      return {
        content: [{
          type: 'text' as const,
          text: 'Stop requested; the run is still terminating (a wedged worker may take a few more seconds to be force-killed). Use tapsmith_list_results to check partial results.',
        }],
      };
    },
  );
}
