import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    // The runner's tests drive fake devices through the real run path; keep
    // the shared telemetry client inert so no unit test ever touches the
    // network. telemetry.test.ts builds its own client with an explicit env.
    env: { TAPSMITH_TELEMETRY: '0' },
  },
});
