import { describe, it, expect, vi } from 'vitest';
import { FixtureRegistry, resolveFixtures, fixtureParameterNames, _testUtils } from '../fixtures.js';
import type { FixtureDefinitions, BuiltinFixtures } from '../fixtures.js';

const { filterOutComments, splitByComma } = _testUtils;

describe('FixtureRegistry', () => {
  it('registers and retrieves fixtures', () => {
    const registry = new FixtureRegistry();
    registry.register({
      myFixture: async (_fixtures, use) => {
        await use('hello');
      },
    } as FixtureDefinitions<{ myFixture: string }, BuiltinFixtures & { myFixture: string }>);

    expect(registry.get('myFixture')).toBeDefined();
    expect(registry.get('myFixture')!.scope).toBe('test');
    expect(registry.names()).toEqual(['myFixture']);
  });

  it('registers fixtures with explicit scope', () => {
    const registry = new FixtureRegistry();
    registry.register({
      workerFixture: [async (_fixtures, use) => {
        await use(42);
      }, { scope: 'worker' }],
    } as FixtureDefinitions<{ workerFixture: number }, BuiltinFixtures & { workerFixture: number }>);

    expect(registry.get('workerFixture')!.scope).toBe('worker');
  });

  it('filters by scope', () => {
    const registry = new FixtureRegistry();
    registry.register({
      testScoped: async (_fixtures, use) => { await use('a'); },
      workerScoped: [async (_fixtures, use) => { await use('b'); }, { scope: 'worker' }],
    } as FixtureDefinitions<{ testScoped: string; workerScoped: string }, BuiltinFixtures & { testScoped: string; workerScoped: string }>);

    const testFixtures = registry.byScope('test');
    const workerFixtures = registry.byScope('worker');
    expect([...testFixtures.keys()]).toEqual(['testScoped']);
    expect([...workerFixtures.keys()]).toEqual(['workerScoped']);
  });

  it('merges registries', () => {
    const a = new FixtureRegistry();
    a.register({
      foo: async (_f, use) => { await use(1); },
    } as FixtureDefinitions<{ foo: number }, BuiltinFixtures & { foo: number }>);

    const b = new FixtureRegistry();
    b.register({
      bar: async (_f, use) => { await use(2); },
    } as FixtureDefinitions<{ bar: number }, BuiltinFixtures & { bar: number }>);

    const merged = a.merge(b);
    expect(merged.names().sort()).toEqual(['bar', 'foo']);
  });

  it('isEmpty returns true for empty registry', () => {
    expect(new FixtureRegistry().isEmpty).toBe(true);
  });

  it('isEmpty returns false after registration', () => {
    const registry = new FixtureRegistry();
    registry.register({
      x: async (_f, use) => { await use(1); },
    } as FixtureDefinitions<{ x: number }, BuiltinFixtures & { x: number }>);
    expect(registry.isEmpty).toBe(false);
  });
});

describe('resolveFixtures', () => {
  it('resolves a test-scoped fixture and runs teardown', async () => {
    const teardownFn = vi.fn();
    const registry = new FixtureRegistry();
    registry.register({
      greeting: async (_fixtures, use) => {
        await use('hello world');
        teardownFn();
      },
    } as FixtureDefinitions<{ greeting: string }, BuiltinFixtures & { greeting: string }>);

    const { fixtures, teardown } = await resolveFixtures(registry, 'test', {});
    expect(fixtures.greeting).toBe('hello world');
    expect(teardownFn).not.toHaveBeenCalled();

    await teardown();
    expect(teardownFn).toHaveBeenCalledOnce();
  });

  it('resolves a worker-scoped fixture', async () => {
    const registry = new FixtureRegistry();
    registry.register({
      counter: [async (_fixtures, use) => {
        await use(42);
      }, { scope: 'worker' }],
    } as FixtureDefinitions<{ counter: number }, BuiltinFixtures & { counter: number }>);

    const { fixtures, teardown } = await resolveFixtures(registry, 'worker', {});
    expect(fixtures.counter).toBe(42);
    await teardown();
  });

  it('provides base fixtures to fixture functions', async () => {
    const receivedDevice = vi.fn();
    const registry = new FixtureRegistry();
    registry.register({
      derived: async (fixtures, use) => {
        receivedDevice(fixtures.device);
        await use('derived-value');
      },
    } as FixtureDefinitions<{ derived: string }, BuiltinFixtures & { derived: string }>);

    const mockDevice = { id: 'mock-device' };
    const { fixtures } = await resolveFixtures(registry, 'test', { device: mockDevice });
    expect(fixtures.derived).toBe('derived-value');
    expect(receivedDevice).toHaveBeenCalledWith(mockDevice);
  });

  it('only resolves fixtures matching the requested scope', async () => {
    const registry = new FixtureRegistry();
    registry.register({
      testOnly: async (_f, use) => { await use('test'); },
      workerOnly: [async (_f, use) => { await use('worker'); }, { scope: 'worker' }],
    } as FixtureDefinitions<{ testOnly: string; workerOnly: string }, BuiltinFixtures & { testOnly: string; workerOnly: string }>);

    const { fixtures: testFixtures } = await resolveFixtures(registry, 'test', {});
    expect(testFixtures.testOnly).toBe('test');
    expect(testFixtures.workerOnly).toBeUndefined();

    const { fixtures: workerFixtures } = await resolveFixtures(registry, 'worker', {});
    expect(workerFixtures.workerOnly).toBe('worker');
    expect(workerFixtures.testOnly).toBeUndefined();
  });

  it('runs teardowns in reverse order', async () => {
    const order: string[] = [];
    const registry = new FixtureRegistry();
    registry.register({
      first: async (_f, use) => {
        await use('a');
        order.push('first-teardown');
      },
      second: async (_f, use) => {
        await use('b');
        order.push('second-teardown');
      },
    } as FixtureDefinitions<{ first: string; second: string }, BuiltinFixtures & { first: string; second: string }>);

    const { teardown } = await resolveFixtures(registry, 'test', {});
    await teardown();
    expect(order).toEqual(['second-teardown', 'first-teardown']);
  });

  it('handles fixture setup errors gracefully', async () => {
    const registry = new FixtureRegistry();
    registry.register({
      broken: async (_f, _use) => {
        throw new Error('setup failed');
      },
    } as FixtureDefinitions<{ broken: string }, BuiltinFixtures & { broken: string }>);

    await expect(resolveFixtures(registry, 'test', {})).rejects.toThrow('setup failed');
  });
});

describe('fixtureParameterNames', () => {
  it('extracts names from arrow function with destructuring', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture mock
    const fn = async ({ foo, bar }: any) => { void foo; void bar; };
    expect(fixtureParameterNames(fn)).toEqual(['foo', 'bar']);
  });

  it('extracts names from regular function', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture mock
    const fn = async function({ device, request }: any) { void device; void request; };
    expect(fixtureParameterNames(fn)).toEqual(['device', 'request']);
  });

  it('returns empty array for no-arg function', () => {
    const fn = async () => {};
    expect(fixtureParameterNames(fn)).toEqual([]);
  });

  it('handles renamed parameters (extracts key, not value)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture mock
    const fn = async ({ foo: myFoo, bar }: any) => { void myFoo; void bar; };
    expect(fixtureParameterNames(fn)).toEqual(['foo', 'bar']);
  });

  it('handles default values', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture mock
    const fn = async ({ foo = 'default', bar }: any) => { void foo; void bar; };
    expect(fixtureParameterNames(fn)).toContain('bar');
  });

  it('strips comments from function body', () => {
    expect(filterOutComments('hello // world\nfoo')).toBe('hello foo');
    expect(filterOutComments('hello /* world */ foo')).toBe('hello  foo');
    expect(filterOutComments('a /* b // c */ d')).toBe('a  d');
  });

  it('splitByComma respects nesting', () => {
    expect(splitByComma('a, b, c')).toEqual(['a', 'b', 'c']);
    expect(splitByComma('a, { b, c }, d')).toEqual(['a', '{ b, c }', 'd']);
    expect(splitByComma('a, [b, c], d')).toEqual(['a', '[b, c]', 'd']);
  });

  it('returns empty for rest properties', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture mock
    const fn = async ({ ...all }: any) => { void all; };
    expect(fixtureParameterNames(fn)).toEqual([]);
  });

  it('returns empty for non-destructured parameter', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture mock
    const fn = async (fixtures: any) => { void fixtures; };
    expect(fixtureParameterNames(fn)).toEqual([]);
  });

  it('caches results on the function object', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture mock
    const fn = async ({ foo }: any) => { void foo; };
    const first = fixtureParameterNames(fn);
    const second = fixtureParameterNames(fn);
    expect(first).toBe(second); // same reference (cached)
  });
});
