import { resolveDeviceTarget, type RequestedProject } from '../connection.js';
import type { TapsmithGrpcClient } from '../../grpc-client.js';
import type { TestDispatcher } from '../test-dispatcher.js';

/**
 * How a device tool says which device it means.
 *
 * `project` is the one a caller can actually know: it is what `run_tests`
 * takes, it is stable across sessions, and it names a platform, which names a
 * device. `device` stays for the cases a project cannot express — two Android
 * emulators, or a device the session is not running tests on.
 */
export interface DeviceRequest {
  device?: string
  project?: string
}

export const DEVICE_ARG_DESCRIPTION =
  'Serial of a device this session drives (see tapsmith_session_info), or the group name '
  + '(e.g. "alice") of a device in a `use.devices` project. Never required: '
  + 'a session on one platform acts on its primary device (worker 0 in UI mode), and a '
  + 'session spanning platforms takes `project`. Pass this only to single out one worker '
  + 'of a parallel run. A device the session merely *sees* cannot be acted on: its daemon '
  + 'is pointed elsewhere, and moving it would leave the agent attached to the previous device.';

export const PROJECT_ARG_DESCRIPTION =
  'Project whose device this should act on (same names as tapsmith_run_tests). '
  + 'Required only when the session drives devices on more than one platform, unless '
  + '`device` is given; it selects that project\'s primary device.';

/** The client for a tool's requested device, with the daemon pointed at it. */
export async function deviceClientFor(
  request: DeviceRequest,
  dispatcher?: TestDispatcher,
): Promise<TapsmithGrpcClient> {
  // Before anything asks what this session drives, not just on the `project`
  // branch. A multi-platform session spawns its per-platform daemons during
  // initialization; a device tool arriving first would otherwise see only the
  // one daemon discovery started, count a single target, and answer from
  // whichever device happened to be Active — silently, because the ambiguity
  // guard never fires on a session that does not yet know it has two devices.
  //
  // Devices only: waiting for the test tree as well would make the first device
  // tool of a session pay for a discovery child per test file.
  if (dispatcher?.ensureDevicesReady) await dispatcher.ensureDevicesReady();
  else await dispatcher?.ensureInitialized?.();
  const project = request.project
    ? await resolveProject(request.project, dispatcher)
    : undefined;
  // `resolveDeviceTarget` points the daemon and records that it did — both
  // matter, and doing the pointing here left the pool's own account of itself
  // stale for every call that followed.
  // A group name (`alice`) names a device the way its tests do; resolve it to
  // the serial the connection pool knows.
  const device = request.device
    ? dispatcher?.resolveDeviceName?.(request.device) ?? request.device
    : undefined;
  const { client } = await resolveDeviceTarget({ device, project });
  return client;
}

async function resolveProject(
  name: string,
  dispatcher?: TestDispatcher,
): Promise<RequestedProject> {
  if (!dispatcher) {
    throw new Error('This session cannot resolve a project name. Pass `device` instead.');
  }
  const projects = dispatcher.getSessionInfo().projects;
  const match = projects.find((p) => p.name === name);
  if (!match) {
    const known = projects.map((p) => p.name).join(', ');
    throw new Error(
      `Unknown project "${name}". ${known ? `This config declares: ${known}.` : 'This config declares none.'}`,
    );
  }
  // The platform may legitimately be undefined — a project inherits it from a
  // root config that declares none — and that is a real answer, not a miss.
  return { name, platform: match.platform };
}
