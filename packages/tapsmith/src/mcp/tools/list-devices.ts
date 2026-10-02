import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listAllDevices, getSessionDeviceSerials } from '../connection.js';
import type { TestDispatcher } from '../test-dispatcher.js';
import type { DeviceInfoProto } from '../../grpc-client.js';
import { androidUnusableDeviceFix } from '../../adb-devices.js';

export function registerListDevicesTool(server: McpServer, dispatcher?: TestDispatcher): void {
  server.tool(
    'tapsmith_list_devices',
    'List all connected mobile devices and emulators across all platforms. Returns serial numbers, platform (android/ios), model, state, and `usable`. A device that is attached but cannot be used (an Android phone whose USB-debugging prompt was not accepted, an offline emulator, …) is listed with `usable: false`, adb\'s state, and a `fix` to tell the user. Once the session has provisioned a `use.devices` group (a test run or device tool does that; listing alone does not), each member also carries its group name (e.g. "alice") and project; device tools (snapshot, tap, etc.) accept that name or the serial as their `device` parameter.',
    {},
    async () => {
      const listed = await listAllDevices();
      const members = groupMembers(dispatcher);

      // In UI mode, only show devices that are part of the session
      const sessionDevices = getSessionDeviceSerials();
      const inSession = (d: DeviceInfoProto): boolean => !sessionDevices || sessionDevices.has(d.serial);

      const row = (d: DeviceInfoProto, usable: boolean) => {
        const member = members.get(d.serial);
        return {
          serial: d.serial,
          model: d.model,
          platform: d.platform,
          os_version: d.osVersion,
          is_emulator: d.isEmulator,
          state: d.state,
          usable,
          // What the user must do first — the advice `doctor` and
          // `tapsmith list-devices` give for the same adb state.
          // Not for `Disconnected`: that is the daemon's word, not an adb state.
          ...(!usable && d.platform === 'android' && d.state !== 'Disconnected'
            ? { fix: androidUnusableDeviceFix(d.state, d.serial) }
            : {}),
          // Only for group members: the name a test author uses for this
          // device, and the `use.devices` project it belongs to.
          ...(member ? { name: member.name, project: member.group } : {}),
        };
      };
      const result = [
        ...listed.devices.filter(inSession).map((d) => row(d, true)),
        ...listed.unusable.filter(inSession).map((d) => row(d, false)),
      ];

      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
}

/**
 * Serial → group membership for the devices this session has provisioned.
 * Read without forcing provisioning: listing devices is often the first call
 * of a session, and booting a group to answer it would be a surprise.
 */
function groupMembers(dispatcher: TestDispatcher | undefined): Map<string, { name: string; group?: string }> {
  const members = new Map<string, { name: string; group?: string }>();
  if (!dispatcher) return members;
  let targets: Array<{ device?: string; name?: string; group?: string }> = [];
  try {
    targets = dispatcher.getSessionInfo().deviceTargets ?? [];
  } catch {
    return members;
  }
  for (const t of targets) {
    if (t.device && t.name && t.group) members.set(t.device, { name: t.name, group: t.group });
  }
  return members;
}
