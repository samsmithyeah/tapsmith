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

  it('tears down already-resolved fixtures when a later fixture fails', async () => {
    const teardownCalled = vi.fn();
    const registry = new FixtureRegistry();
    registry.register({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture mock
      good: async (_f: any, use: any) => {
        await use('ok');
        teardownCalled();
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture mock
      bad: async (_f: any, _use: any) => {
        throw new Error('boom');
      },
    } as FixtureDefinitions<{ good: string; bad: string }, BuiltinFixtures & { good: string; bad: string }>);

    await expect(resolveFixtures(registry, 'test', {})).rejects.toThrow('boom');
    expect(teardownCalled).toHaveBeenCalledOnce();
  });
});

describe('lazy fixture resolution', () => {
  it('resolves only requested fixtures and their deps', async () => {
    const order: string[] = [];
    const registry = new FixtureRegistry();
    registry.register({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture mock
      base: async (_fixtures: any, use: any) => { order.push('base'); await use('base-val'); },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture mock
      dep: async ({ base }: any, use: any) => { order.push('dep'); await use(`dep-val-${base}`); },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture mock
      unused: async (_fixtures: any, use: any) => { order.push('unused'); await use('unused-val'); },
    } as FixtureDefinitions<{ base: string; dep: string; unused: string }, BuiltinFixtures & { base: string; dep: string; unused: string }>);

    const { fixtures, teardown } = await resolveFixtures(registry, 'test', {}, ['dep']);
    expect(order).toEqual(['base', 'dep']);
    expect(fixtures.dep).toBe('dep-val-base-val');
    expect(fixtures.base).toBe('base-val');
    expect(fixtures.unused).toBeUndefined();
    await teardown();
  });

  it('resolves all fixtures when requestedNames is omitted', async () => {
    const order: string[] = [];
    const registry = new FixtureRegistry();
    registry.register({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture mock
      a: async (_fixtures: any, use: any) => { order.push('a'); await use('a-val'); },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture mock
      b: async (_fixtures: any, use: any) => { order.push('b'); await use('b-val'); },
    } as FixtureDefinitions<{ a: string; b: string }, BuiltinFixtures & { a: string; b: string }>);

    const { fixtures, teardown } = await resolveFixtures(registry, 'test', {});
    expect(order).toEqual(['a', 'b']);
    expect(fixtures.a).toBe('a-val');
    expect(fixtures.b).toBe('b-val');
    await teardown();
  });
});

describe('FixtureRegistry.collectDeps', () => {
  it('returns deps in dependency-first order', () => {
    const registry = new FixtureRegistry();
    registry.register({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture mock
      base: async (_fixtures: any, use: any) => { await use('b'); },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture mock
      mid: async ({ base }: any, use: any) => { await use(base); },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture mock
      top: async ({ mid }: any, use: any) => { await use(mid); },
    } as FixtureDefinitions<{ base: string; mid: string; top: string }, BuiltinFixtures & { base: string; mid: string; top: string }>);

    expect(registry.collectDeps(['top'], 'test')).toEqual(['base', 'mid', 'top']);
  });

  it('skips fixtures of different scope', () => {
    const registry = new FixtureRegistry();
    registry.register({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture mock
      workerLevel: [async (_fixtures: any, use: any) => { await use('w'); }, { scope: 'worker' }],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture mock
      testLevel: async ({ workerLevel }: any, use: any) => { await use(workerLevel); },
    } as FixtureDefinitions<{ workerLevel: string; testLevel: string }, BuiltinFixtures & { workerLevel: string; testLevel: string }>);

    // When collecting test-scoped deps, the worker-scoped dep is skipped
    expect(registry.collectDeps(['testLevel'], 'test')).toEqual(['testLevel']);
  });

  it('handles diamond dependencies without duplicates', () => {
    const registry = new FixtureRegistry();
    registry.register({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture mock
      root: async (_f: any, use: any) => { await use('r'); },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture mock
      left: async ({ root }: any, use: any) => { await use(root); },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture mock
      right: async ({ root }: any, use: any) => { await use(root); },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture mock
      top: async ({ left, right }: any, use: any) => { await use(`${left}-${right}`); },
    } as FixtureDefinitions<{ root: string; left: string; right: string; top: string }, BuiltinFixtures & { root: string; left: string; right: string; top: string }>);

    const deps = registry.collectDeps(['top'], 'test');
    expect(deps).toEqual(['root', 'left', 'right', 'top']);
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

  it('handles destructuring with default value on the parameter itself', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture mock
    const fn = async ({ foo, bar }: any = {}) => { void foo; void bar; };
    expect(fixtureParameterNames(fn)).toEqual(['foo', 'bar']);
  });

  it('handles default values with braces or commas in string literals', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture mock
    const fn = async ({ foo = 'a, b }', bar }: any) => { void foo; void bar; };
    expect(fixtureParameterNames(fn)).toEqual(['foo', 'bar']);
  });

  it('strips comments from function body', () => {
    expect(filterOutComments('hello // world\nfoo')).toBe('hello foo');
    expect(filterOutComments('hello /* world */ foo')).toBe('hello  foo');
    expect(filterOutComments('a /* b // c */ d')).toBe('a  d');
    expect(filterOutComments('const url = "http://example.com"')).toBe('const url = "http://example.com"');
    expect(filterOutComments("const s = 'a // b'")).toBe("const s = 'a // b'");
    expect(filterOutComments('const t = `http://${host}`')).toBe('const t = `http://${host}`');
    expect(filterOutComments("const s = 'a \\\\'; // comment")).toBe("const s = 'a \\\\'; ");
  });

  it('splitByComma respects nesting', () => {
    expect(splitByComma('a, b, c')).toEqual(['a', 'b', 'c']);
    expect(splitByComma('a, { b, c }, d')).toEqual(['a', '{ b, c }', 'd']);
    expect(splitByComma('a, [b, c], d')).toEqual(['a', '[b, c]', 'd']);
    expect(splitByComma('a, (b, c), d')).toEqual(['a', '(b, c)', 'd']);
    expect(splitByComma('a, "b, c", d')).toEqual(['a', '"b, c"', 'd']);
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
