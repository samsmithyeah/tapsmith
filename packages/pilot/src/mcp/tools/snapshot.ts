import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ensureConnected } from '../connection.js';
import { parseHierarchyXml } from '../../trace-viewer/components/hierarchy-utils.js';
import { formatHierarchy } from '../hierarchy-formatter.js';

export function registerSnapshotTool(server: McpServer): void {
  server.tool(
    'pilot_snapshot',
    'Get the current screen\'s accessibility tree with copy-paste-ready Pilot selectors for each interactive element. Use this first when writing tests to see what\'s on screen. Then validate selectors with pilot_test_selector before putting them in test code.',
    {
      device: z.string().optional().describe('Device serial (optional, uses default device)'),
    },
    async ({ device }) => {
      const client = await ensureConnected();
      if (device) await client.setDevice(device);

      const { hierarchyXml, errorMessage } = await client.getUiHierarchy();
      if (errorMessage) {
        return { content: [{ type: 'text' as const, text: `Error: ${errorMessage}` }], isError: true };
      }

      const roots = parseHierarchyXml(hierarchyXml);
      const { tree, selectors } = formatHierarchy(roots);

      const output = selectors.length > 0
        ? `${tree}\n\n## Suggested Selectors\n${selectors.join('\n')}`
        : tree || '(empty screen)';

      return { content: [{ type: 'text' as const, text: output }] };
    },
  );
}
