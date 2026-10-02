import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// device-session's startDaemon is how the CLI, watch and UI mode start a
// device group's member daemons. One that dies says why, in its own words
// (PILOT-463). A shell script stands in for tapsmith-core; gRPC never answers.

vi.mock('../grpc-client.js', () => ({
  TapsmithGrpcClient: class {
    waitForReady(): Promise<boolean> { return new Promise(() => {}); }
    close(): void {}
  },
}));

const { startDaemon } = await import('../device-session.js');

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-session-daemon-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('device-session startDaemon()', () => {
  it('fails with the daemon\'s stderr when it exits, without asking about the install', async () => {
    const bin = path.join(tmpDir, 'tapsmith-core');
    fs.writeFileSync(bin, '#!/bin/sh\necho "Error: Address already in use (os error 48)" >&2\nexit 1\n', { mode: 0o755 });

    const err = await startDaemon({ daemonBin: bin, port: 50999, agentPort: 18999, describe: 'daemon for bob' })
      .then(() => undefined, (e: unknown) => e);
    expect((err as Error).message.split('\n')).toEqual([
      'daemon for bob on port 50999 did not start: tapsmith-core exited with code 1 before it answered',
      '  Recent daemon output:',
      '    Error: Address already in use (os error 48)',
    ]);
  });

  it('asks about the install when the binary is missing', async () => {
    const err = await startDaemon({ daemonBin: path.join(tmpDir, 'nope'), port: 50999, agentPort: 18999 })
      .then(() => undefined, (e: unknown) => e);
    expect((err as Error).message).toContain('Is tapsmith-core installed?');
  });
});
