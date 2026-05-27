/**
 * Fixture system for Tapsmith tests.
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
  deps: string[]
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
        this._fixtures.set(name, { fn, scope: opts.scope, deps: fixtureParameterNames(fn) });
      } else {
        const fn = def as FixtureFn<unknown, Record<string, unknown>>;
        this._fixtures.set(name, { fn, scope: 'test', deps: fixtureParameterNames(fn) });
      }
    }
  }

  /** Get a fixture definition by name. */
  get(name: string): ResolvedFixture | undefined {
    return this._fixtures.get(name);
  }

  /** Check if a fixture is registered by name. */
  has(name: string): boolean {
    return this._fixtures.has(name);
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

  /**
   * Collect transitive dependencies for the given fixture names, filtered to a
   * scope. Returns names in dependency-first (setup) order.
   */
  collectDeps(names: string[], scope: FixtureScope): string[] {
    const ordered: string[] = [];
    const visited = new Set<string>();

    const visit = (name: string) => {
      if (visited.has(name)) return;
      visited.add(name);
      const fixture = this._fixtures.get(name);
      if (!fixture || fixture.scope !== scope) return;
      for (const dep of fixture.deps) {
        visit(dep);
      }
      ordered.push(name);
    };

    for (const name of names) {
      visit(name);
    }
    return ordered;
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
  requestedNames?: string[],
): Promise<{ fixtures: Record<string, unknown>; teardown: () => Promise<void> }> {
  const fixtures: Record<string, unknown> = { ...baseFixtures };
  const teardowns: (() => Promise<void>)[] = [];

  const fixturesToResolve: [string, ResolvedFixture][] = requestedNames
    ? registry.collectDeps(requestedNames, scope)
        .map(name => [name, registry.get(name)!] as [string, ResolvedFixture])
    : [...registry.byScope(scope)];

  for (const [name, def] of fixturesToResolve) {
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
          process.stderr.write(`[tapsmith] fixture teardown error: ${msg}\n`);
        }
      }
    },
  };
}

// ─── Fixture parameter name parsing ───

const signatureSymbol = Symbol('signature');

function filterOutComments(s: string): string {
  const result: string[] = [];
  let commentState: 'none' | 'singleline' | 'multiline' = 'none';
  let stringState: 'none' | 'single' | 'double' | 'template' = 'none';
  for (let i = 0; i < s.length; ++i) {
    if (commentState === 'none') {
      if (stringState === 'none') {
        if (s[i] === "'" && s[i - 1] !== '\\') {
          stringState = 'single';
        } else if (s[i] === '"' && s[i - 1] !== '\\') {
          stringState = 'double';
        } else if (s[i] === '`' && s[i - 1] !== '\\') {
          stringState = 'template';
        } else if (s[i] === '/' && s[i + 1] === '/') {
          commentState = 'singleline';
          continue;
        } else if (s[i] === '/' && s[i + 1] === '*') {
          commentState = 'multiline';
          i++;
          continue;
        }
      } else {
        if (stringState === 'single' && s[i] === "'" && s[i - 1] !== '\\') {
          stringState = 'none';
        } else if (stringState === 'double' && s[i] === '"' && s[i - 1] !== '\\') {
          stringState = 'none';
        } else if (stringState === 'template' && s[i] === '`' && s[i - 1] !== '\\') {
          stringState = 'none';
        }
      }
    }

    if (commentState === 'singleline') {
      if (s[i] === '\n')
        commentState = 'none';
    } else if (commentState === 'multiline') {
      if (s[i - 1] === '*' && s[i] === '/')
        commentState = 'none';
    } else {
      result.push(s[i]);
    }
  }
  return result.join('');
}

function splitByComma(s: string): string[] {
  const result: string[] = [];
  const stack: string[] = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '{' || s[i] === '[' || s[i] === '(') {
      stack.push(s[i] === '{' ? '}' : s[i] === '[' ? ']' : ')');
    } else if (s[i] === stack[stack.length - 1]) {
      stack.pop();
    } else if (!stack.length && s[i] === ',') {
      const token = s.substring(start, i).trim();
      if (token)
        result.push(token);
      start = i + 1;
    }
  }
  const lastToken = s.substring(start).trim();
  if (lastToken)
    result.push(lastToken);
  return result;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type -- Function.toString() is the input
function innerFixtureParameterNames(fn: Function): string[] {
  const text = filterOutComments(fn.toString());
  const match = text.match(/(?:async)?(?:\s+function)?[^(]*\(([^)]*)/);
  if (!match)
    return [];
  const trimmedParams = match[1].trim();
  if (!trimmedParams)
    return [];
  const [firstParam] = splitByComma(trimmedParams);
  if (firstParam[0] !== '{' || firstParam[firstParam.length - 1] !== '}')
    return [];
  const props = splitByComma(firstParam.substring(1, firstParam.length - 1)).map(prop => {
    const eq = prop.indexOf('=');
    const colon = prop.indexOf(':');
    if (colon !== -1 && (eq === -1 || colon < eq))
      return prop.substring(0, colon).trim();
    if (eq !== -1)
      return prop.substring(0, eq).trim();
    return prop.trim();
  });
  const restProperty = props.find(prop => prop.startsWith('...'));
  if (restProperty)
    return [];
  return props;
}

/**
 * Parse the destructured parameter names from a function signature.
 * Used for lazy fixture resolution — only fixtures that are actually
 * destructured by the test/hook function are resolved.
 *
 * Ported from Playwright's fixture parameter parsing.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type -- Function.toString() is the input
export function fixtureParameterNames(fn: Function): string[] {
  const cached = (fn as unknown as Record<symbol, string[]>)[signatureSymbol];
  if (cached)
    return cached;
  const names = innerFixtureParameterNames(fn);
  (fn as unknown as Record<symbol, string[]>)[signatureSymbol] = names;
  return names;
}

/** @internal Exported for testing only. */
export const _testUtils = { filterOutComments, splitByComma };
