import { resolveDeviceTarget } from '../connection.js';
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
  'Device serial from tapsmith_list_devices. Optional when the session drives one device; '
  + 'use `project` instead to name a device by the project that runs on it.';

export const PROJECT_ARG_DESCRIPTION =
  'Project whose device this should act on (same names as tapsmith_run_tests). '
  + 'Required when the session drives more than one device, unless `device` is given.';

/** The client for a tool's requested device, with the daemon pointed at it. */
export async function deviceClientFor(
  request: DeviceRequest,
  dispatcher?: TestDispatcher,
): Promise<TapsmithGrpcClient> {
  const platform = request.project
    ? await platformForProject(request.project, dispatcher)
    : undefined;
  const { client } = await resolveDeviceTarget({ device: request.device, platform });
  // Only for an explicitly named device: it may be one this daemon can see but
  // is not currently pointed at. Everything else resolved to the daemon's own
  // device, and re-pointing a UI worker's daemon at what it already holds is a
  // needless round trip at best.
  if (request.device) await client.setDevice(request.device);
  return client;
}

async function platformForProject(
  project: string,
  dispatcher?: TestDispatcher,
): Promise<string | undefined> {
  if (!dispatcher) {
    throw new Error('This session cannot resolve a project name. Pass `device` instead.');
  }
  await dispatcher.ensureInitialized?.();
  const projects = dispatcher.getSessionInfo().projects;
  const match = projects.find((p) => p.name === project);
  if (!match) {
    const known = projects.map((p) => p.name).join(', ');
    throw new Error(
      `Unknown project "${project}". ${known ? `This config declares: ${known}.` : 'This config declares none.'}`,
    );
  }
  return match.platform;
}
