/**
 * Fixture system for Pilot tests.
 *
 * Provides `test.extend()` for defining custom fixtures with test or worker
 * scope. Follows the Playwright fixture pattern where setup/teardown is
 * managed via the `use()` callback.
 *
 * @see PILOT-108
 */

import type { Device } from './device.js';
import type { APIRequestContext } from './api-request.js';

// ─── Types ───

export type FixtureScope = 'test' | 'worker'

/** The `use` callback provided to fixture functions. */
export type UseFn<T> = (value: T) => Promise<void>

/**
 * A fixture definition function. Receives all other fixtures as the first
 * argument and a `use` callback as the second. The fixture sets up its
 * value, passes it to `use()`, and cleans up after `use()` resolves.
 */
export type FixtureFn<T, F extends Record<string, unknown>> = (
  fixtures: F,
  use: UseFn<T>,
) => Promise<void>

/** A fixture definition: either a bare function (test scope) or a tuple with options. */
export type FixtureDefinition<T, F extends Record<string, unknown>> =
  | FixtureFn<T, F>
  | [FixtureFn<T, F>, { scope: FixtureScope }]

/** Map of fixture names to their definitions. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- F is a merged fixture context that may include interfaces without index signatures
export type FixtureDefinitions<T extends Record<string, unknown>, F = any> = {
  [K in keyof T]: FixtureDefinition<T[K], F & T & Record<string, unknown>>
}

/** Internal resolved fixture entry. */
export interface ResolvedFixture<T = unknown> {
  fn: FixtureFn<T, Record<string, unknown>>
  scope: FixtureScope
}

// ─── Built-in fixtures ───

export interface BuiltinFixtures {
  device: Device
  request: APIRequestContext
}

// ─── Fixture registry ───

/**
 * A registry of fixture definitions. Created by `test.extend()` and used
 * by the runner to resolve fixtures at the appropriate scope.
 */
export class FixtureRegistry {
  private _fixtures: Map<string, ResolvedFixture> = new Map();

  /** Register fixture definitions from a `test.extend()` call. */
  register<T extends Record<string, unknown>>(
    definitions: FixtureDefinitions<T, BuiltinFixtures & T>,
  ): void {
    for (const [name, def] of Object.entries(definitions)) {
      if (Array.isArray(def)) {
        const [fn, opts] = def as [FixtureFn<unknown, Record<string, unknown>>, { scope: FixtureScope }];
        this._fixtures.set(name, { fn, scope: opts.scope });
      } else {
        this._fixtures.set(name, {
          fn: def as FixtureFn<unknown, Record<string, unknown>>,
          scope: 'test',
        });
      }
    }
  }

  /** Get a fixture definition by name. */
  get(name: string): ResolvedFixture | undefined {
    return this._fixtures.get(name);
  }

  /** Get all fixture names. */
  names(): string[] {
    return [...this._fixtures.keys()];
  }

  /** Get all fixtures with the given scope. */
  byScope(scope: FixtureScope): Map<string, ResolvedFixture> {
    const result = new Map<string, ResolvedFixture>();
    for (const [name, fixture] of this._fixtures) {
      if (fixture.scope === scope) {
        result.set(name, fixture);
      }
    }
    return result;
  }

  /** Whether any fixtures are registered. */
  get isEmpty(): boolean {
    return this._fixtures.size === 0;
  }

  /** Create a copy of this registry with additional fixtures merged in. */
  merge(other: FixtureRegistry): FixtureRegistry {
    const merged = new FixtureRegistry();
    for (const [name, fixture] of this._fixtures) {
      merged._fixtures.set(name, fixture);
    }
    for (const [name, fixture] of other._fixtures) {
      merged._fixtures.set(name, fixture);
    }
    return merged;
  }
}

// ─── Fixture resolution ───

/**
 * Resolve and run fixtures for a given scope. Returns the fixture values
 * and a teardown function that runs all fixture teardown in reverse order.
 *
 * The `use()` pattern works by creating a promise per fixture:
 * - The fixture function calls `use(value)`, which resolves a "provided" promise
 * - The runner consumes the value
 * - When teardown is triggered, the "teardown" promise resolves, allowing the
 *   fixture function to continue past `use()` and run cleanup
 */
export async function resolveFixtures(
  registry: FixtureRegistry,
  scope: FixtureScope,
  baseFixtures: Record<string, unknown>,
): Promise<{ fixtures: Record<string, unknown>; teardown: () => Promise<void> }> {
  const fixtures: Record<string, unknown> = { ...baseFixtures };
  const teardowns: (() => Promise<void>)[] = [];

  const scopedFixtures = registry.byScope(scope);

  for (const [name, def] of scopedFixtures) {
    // Create the use/teardown promise pair
    let resolveUse: (value: unknown) => void;
    let resolveTeardown: () => void;
    let fixtureError: unknown;

    const usePromise = new Promise<unknown>((resolve) => {
      resolveUse = resolve;
    });
    const teardownPromise = new Promise<void>((resolve) => {
      resolveTeardown = resolve;
    });

    // Run the fixture function in the background
    const fixturePromise = def.fn(fixtures, async (value: unknown) => {
      resolveUse!(value);
      // Wait for teardown signal
      await teardownPromise;
    }).catch((err) => {
      fixtureError = err;
      // Resolve use in case the fixture errored before calling use()
      resolveUse!(undefined);
    });

    // Wait for the fixture to provide its value
    const value = await usePromise;

    if (fixtureError) {
      throw fixtureError;
    }

    fixtures[name] = value;

    // Queue teardown (run in reverse order)
    teardowns.unshift(async () => {
      resolveTeardown!();
      await fixturePromise;
    });
  }

  return {
    fixtures,
    teardown: async () => {
      for (const fn of teardowns) {
        try {
          await fn();
        } catch (err) {
          // Teardown errors should not mask test errors, but log for diagnosability
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[pilot] fixture teardown error: ${msg}\n`);
        }
      }
    },
  };
}
