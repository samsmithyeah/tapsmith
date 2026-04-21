import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ensureConnected } from '../connection.js';
import { parseHierarchyXml } from '../../trace-viewer/components/hierarchy-utils.js';
import { parseSelectorString, findMatchingNodes } from '../../trace-viewer/components/selector-matching.js';
import { getNodeRole } from '../../trace-viewer/components/hierarchy-utils.js';

export function registerTestSelectorTool(server: McpServer): void {
  server.tool(
    'pilot_test_selector',
    'Test a Pilot selector against the current screen. Returns whether it matches, how many elements match, and details about each match. Use to validate selectors before putting them in test code.',
    {
      selector: z.string().describe('Pilot selector string, e.g. device.getByRole("button", { name: "Login" })'),
      device: z.string().optional().describe('Device serial (optional, uses default device)'),
    },
    async ({ selector, device }) => {
      const client = await ensureConnected();
      if (device) await client.setDevice(device);

      const parsed = parseSelectorString(selector);
      if (!parsed) {
        return {
          content: [{ type: 'text' as const, text: `Invalid selector: "${selector}". Use device.getByRole(), getByText(), getByDescription(), getByPlaceholder(), or getByTestId().` }],
          isError: true,
        };
      }

      const { hierarchyXml, errorMessage } = await client.getUiHierarchy();
      if (errorMessage) {
        return { content: [{ type: 'text' as const, text: `Error: ${errorMessage}` }], isError: true };
      }

      const roots = parseHierarchyXml(hierarchyXml);
      const matches = findMatchingNodes(roots, parsed);

      const elements = matches.map(node => {
        const role = getNodeRole(node);
        const text = node.attributes.get('text') ?? node.attributes.get('label') ?? '';
        const bounds = node.attributes.get('bounds') ?? '';
        return { role, text, bounds };
      });

      const result = {
        matched: matches.length > 0,
        count: matches.length,
        elements,
      };

      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}
