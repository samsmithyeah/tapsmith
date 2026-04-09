/**
 * Pilot — Mobile app testing framework.
 *
 * Public API re-exports.
 */

// Device
export { Device, type SwipeOptions } from './device.js';

// Device management types
export type { LaunchAppOptions, AppState, Orientation, ColorScheme } from './grpc-client.js';

// ElementHandle
export {
  ElementHandle,
  type FilterOptions,
  type BoundingBox,
  type LocatorOptions,
} from './element-handle.js';

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
  type UseOptions,
} from './runner.js';

// Fixtures
export {
  type FixtureScope,
  type FixtureDefinitions,
  type BuiltinFixtures,
} from './fixtures.js';

// Config
export { defineConfig, loadConfig, type PilotConfig, type ProjectConfig, type ScreenshotMode, type TraceMode, type TraceConfig } from './config.js';

// Reporters
export {
  type PilotReporter,
  type FullResult,
  type ReporterConfig,
  type ReporterDescription,
} from './reporter.js';

// gRPC client (advanced usage)
export { PilotGrpcClient } from './grpc-client.js';

// Tracing
export { Tracing, type TracingStartOptions, type TracingStopOptions } from './trace/tracing.js';

// ESLint plugin
export { default as eslintPlugin } from './eslint-plugin/index.js';
