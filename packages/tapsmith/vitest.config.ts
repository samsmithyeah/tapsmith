import * as os from 'node:os';
import * as path from 'node:path';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    // The runner's tests drive fake devices through the real run path; keep
    // the shared telemetry client inert so no unit test ever touches the
    // network. telemetry.test.ts builds its own client with an explicit env.
    //
    // Device claims (PILOT-381) go to a throwaway registry: a test that opens
    // a fake device session must never claim — or be refused — a device in the
    // developer's real `~/.tapsmith/claims`.
    env: {
      TAPSMITH_TELEMETRY: '0',
      TAPSMITH_CLAIMS_DIR: path.join(os.tmpdir(), `tapsmith-unit-claims-${process.pid}`),
    },
  },
});
