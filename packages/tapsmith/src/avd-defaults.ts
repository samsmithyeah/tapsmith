/**
 * `tapsmith create-avd` defaults. Kept apart from `create-avd.ts` so the CLI's
 * help can print them without loading the command itself.
 */

import { hostArch } from './host-arch.js';

export const DEFAULT_API_LEVEL = 36;
export const DEFAULT_DEVICE_PROFILE = 'medium_phone';

/**
 * Map the host architecture to the matching emulator image ABI — the
 * machine's, not Node's: an x64 Node under Rosetta still gets arm64-v8a.
 */
export function defaultAbi(arch: string = hostArch()): string {
  return arch === 'arm64' ? 'arm64-v8a' : 'x86_64';
}

export function defaultAvdName(api: number): string {
  return `Tapsmith_Phone_API_${api}`;
}
