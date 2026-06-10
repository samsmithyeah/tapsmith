import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ensureConnected } from '../connection.js';
import { parseHierarchyXml } from '../../trace-viewer/components/hierarchy-utils.js';
import { parseSelectorString, findMatchingNodes, applyPositionalIndex } from '../../trace-viewer/components/selector-matching.js';
import { getNodeRole } from '../../trace-viewer/components/hierarchy-utils.js';
import { parseSelectorToInternal, formatBounds } from '../selector-helper.js';
import { collapseSameTargetDuplicates } from '../../element-handle.js';
import type { ElementInfo } from '../../grpc-client.js';

/** Snapshot lookup — the agent's findElements does not auto-wait, so a short
 *  timeout keeps the tool responsive while covering daemon round-trip time. */
const TEST_SELECTOR_TIMEOUT_MS = 1_000;

const STRICT_HINT =
  'Actions and assertions on this selector will throw a strict mode violation at runtime. ' +
  'Disambiguate with { exact: true }, getByRole(role, { name }), getByTestId(), or .first()/.nth()/.last().';

export function registerTestSelectorTool(server: McpServer): void {
  server.tool(
    'tapsmith_test_selector',
    'Test a Tapsmith selector against the current screen using the same matching the test runner uses at runtime. Returns whether it matches, how many elements match, and details about each match. Warns when a selector is ambiguous (multiple matches), which makes runtime actions throw a strict mode violation. Use to validate selectors before putting them in test code.',
    {
      selector: z.string().describe('Tapsmith selector string, e.g. device.getByRole("button", { name: "Login" })'),
      device: z.string().optional().describe('Device serial from tapsmith_list_devices (optional, uses default device)'),
    },
    async ({ selector, device }) => {
      const client = await ensureConnected(device);
      if (device) await client.setDevice(device);

      const parsed = parseSelectorString(selector);
      if (!parsed) {
        return {
          content: [{ type: 'text' as const, text: `Invalid selector: "${selector}". Use device.getByRole(), getByText(), getByDescription(), getByPlaceholder(), or getByTestId().` }],
          isError: true,
        };
      }

      // WebView selectors can't be resolved through the native find path —
      // match against the hierarchy snapshot with runtime-aligned semantics.
      if (parsed.type.startsWith('wv-')) {
        const { hierarchyXml, errorMessage } = await client.getUiHierarchy();
        if (errorMessage) {
          return { content: [{ type: 'text' as const, text: `Error: ${errorMessage}` }], isError: true };
        }
        const roots = parseHierarchyXml(hierarchyXml);
        const matches = findMatchingNodes(roots, parsed);
        const elements = matches.map(node => ({
          role: getNodeRole(node),
          text: node.attributes.get('text') ?? node.attributes.get('label') ?? '',
          bounds: node.attributes.get('bounds') ?? '',
        }));
        const result = {
          matched: matches.length > 0,
          count: matches.length,
          elements,
          note: 'WebView selector — matched against the hierarchy snapshot, not the live runtime.',
        };
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      }

      // Native selectors resolve through the daemon/agent — the exact code
      // path the test runner uses — so playground results can never diverge
      // from runtime matching again (PILOT-226).
      const { selector: sel, index } = parseSelectorToInternal(selector);
      const res = await client.findElements(sel, TEST_SELECTOR_TIMEOUT_MS);
      if (res.errorMessage) {
        return { content: [{ type: 'text' as const, text: `Error: ${res.errorMessage}` }], isError: true };
      }
      // Same duplicate-collapsing the runtime applies (iOS exposes some text
      // elements twice with identical label/bounds).
      const all = collapseSameTargetDuplicates(res.elements ?? []);

      // Apply a positional chain the same way the runtime does
      // (negative .nth() indices count from the end).
      const resolved: ElementInfo[] = applyPositionalIndex(all, index);

      const elements = resolved.map(el => ({
        role: el.role || el.className,
        text: el.text,
        bounds: formatBounds(el.bounds),
      }));

      const result: Record<string, unknown> = {
        matched: resolved.length > 0,
        count: resolved.length,
        elements,
      };
      if (index !== undefined && all.length !== resolved.length) {
        result.totalMatches = all.length;
      }
      if (index === undefined && all.length > 1) {
        result.strictModeWarning = STRICT_HINT;
      }

      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}
