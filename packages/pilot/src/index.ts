/**
 * Pilot — Mobile app testing framework.
 *
 * Public API re-exports.
 */

// Selectors
export {
  role,
  text,
  textContains,
  contentDesc,
  hint,
  className,
  testId,
  id,
  xpath,
  type Selector,
  type SelectorKind,
  type RoleSelectorValue,
} from './selectors.js';

// Device
export { Device } from './device.js';

// ElementHandle
export { ElementHandle } from './element-handle.js';

// Assertions
export { expect, flushSoftErrors, type PilotAssertions, type GenericAssertions, type PollOptions } from './expect.js';

// Test runner
export {
  test,
  describe,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  type TestFn,
  type DescribeFn,
  type TestFixtures,
  type TestResult,
  type SuiteResult,
  type TestStatus,
} from './runner.js';

// Config
export { defineConfig, loadConfig, type PilotConfig, type ScreenshotMode } from './config.js';

// gRPC client (advanced usage)
export { PilotGrpcClient } from './grpc-client.js';

// ESLint plugin
export { default as eslintPlugin } from './eslint-plugin/index.js';
