import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { deviceClientFor, DEVICE_ARG_DESCRIPTION, PROJECT_ARG_DESCRIPTION } from './device-target.js';
import type { TestDispatcher } from '../test-dispatcher.js';
import { resolveActionTarget } from '../locator-helper.js';

/** The tool result for a daemon action: its error, or "OK". */
export function actionResult(success: boolean, errorMessage?: string) {
  // A failure the daemon gave no reason for is still a failure: reporting it
  // as "OK" is exactly the silent success an agent cannot detect.
  if (!success) {
    const reason = errorMessage || 'the device reported the action failed but gave no reason';
    return { content: [{ type: 'text' as const, text: `Error: ${reason}` }], isError: true };
  }
  return { content: [{ type: 'text' as const, text: 'OK' }] };
}

export function registerDeviceActionTools(server: McpServer, dispatcher?: TestDispatcher): void {
  server.tool(
    'tapsmith_tap',
    'Tap a UI element matching the given Tapsmith locator. Use tapsmith_snapshot first to find the right locator.',
    {
      locator: z.string().describe('Tapsmith locator, e.g. device.getByRole("button", { name: "Login" })'),
      device: z.string().optional().describe(DEVICE_ARG_DESCRIPTION),
      project: z.string().optional().describe(PROJECT_ARG_DESCRIPTION),
    },
    async ({ locator, device, project }) => {
      const client = await deviceClientFor({ device, project }, dispatcher);
      // Strict mode (PILOT-226): resolve through the runtime find path so an
      // ambiguous locator errors with the match list instead of silently
      // tapping the first match.
      const target = await resolveActionTarget(client, locator);
      if (target.error) return actionResult(false, target.error);
      // Positional targets carry an elementId — act on that exact element.
      const { success, errorMessage } = await client.tap(target.elementId ? undefined : target.selector, undefined, target.elementId);
      return actionResult(success, errorMessage);
    },
  );

  server.tool(
    'tapsmith_type',
    'Type text into an element matching the locator. Set clear=true to replace existing text.',
    {
      locator: z.string().describe('Tapsmith locator for the text field'),
      text: z.string().describe('Text to type'),
      clear: z.boolean().optional().describe('Clear existing text before typing. If the clear fails, the call returns that error and types nothing.'),
      device: z.string().optional().describe(DEVICE_ARG_DESCRIPTION),
      project: z.string().optional().describe(PROJECT_ARG_DESCRIPTION),
    },
    async ({ locator, text, clear, device, project }) => {
      const client = await deviceClientFor({ device, project }, dispatcher);
      const target = await resolveActionTarget(client, locator);
      if (target.error) return actionResult(false, target.error);
      const sel = target.elementId ? undefined : target.selector;
      if (clear) {
        // Typing after a failed clear appends to the old text, so stop here.
        const cleared = await client.clearText(sel, undefined, target.elementId);
        if (!cleared.success) {
          const reason = cleared.errorMessage || 'the device gave no reason';
          return actionResult(false, `could not clear the field before typing, so nothing was typed: ${reason}`);
        }
      }
      const { success, errorMessage } = await client.typeText(sel, text, undefined, undefined, target.elementId);
      return actionResult(success, errorMessage);
    },
  );

  server.tool(
    'tapsmith_swipe',
    'Swipe on the device screen in the given direction. Use to scroll or navigate between screens.',
    {
      direction: z.enum(['up', 'down', 'left', 'right']).describe('Swipe direction'),
      device: z.string().optional().describe(DEVICE_ARG_DESCRIPTION),
      project: z.string().optional().describe(PROJECT_ARG_DESCRIPTION),
    },
    async ({ direction, device, project }) => {
      const client = await deviceClientFor({ device, project }, dispatcher);
      const { success, errorMessage } = await client.swipe(direction);
      return actionResult(success, errorMessage);
    },
  );

  server.tool(
    'tapsmith_press_key',
    'Press a device key. Common keys: back, home, enter, tab, delete.',
    {
      key: z.string().describe('Key name: back, home, enter, tab, delete, etc.'),
      device: z.string().optional().describe(DEVICE_ARG_DESCRIPTION),
      project: z.string().optional().describe(PROJECT_ARG_DESCRIPTION),
    },
    async ({ key, device, project }) => {
      const client = await deviceClientFor({ device, project }, dispatcher);
      const { success, errorMessage } = await client.pressKey(key);
      return actionResult(success, errorMessage);
    },
  );
}
