import { describe, it, expect as vitestExpect } from 'vitest';

import { test, describe as tapsmithDescribe, expect, ElementHandle } from '../index.js';
import { _text } from '../selectors.js';
import type { TapsmithGrpcClient } from '../grpc-client.js';

// Playwright names Tapsmith does not implement (yet) must fail with a message
// that names the API, instead of the bundler-mangled
// "import_tapsmith.test.step is not a function" (PILOT-544).

type Untyped = Record<string, (...args: unknown[]) => unknown>;

const DOCS = 'https://tapsmith.dev/reference/api/test-runner/#playwright-apis-not-supported-yet';

describe('Playwright test APIs that are not supported yet', () => {
  const cases: [string, () => unknown, RegExp][] = [
    ['test.step', () => (test as unknown as Untyped).step('log in', async () => {}), /device\.tracing\.group/],
    ['test.fixme', () => (test as unknown as Untyped).fixme('broken', async () => {}), /test\.skip/],
    ['test.fail', () => (test as unknown as Untyped).fail('known bug', async () => {}), /./],
    ['test.slow', () => (test as unknown as Untyped).slow(), /test\.use\(\{ timeout \}\)/],
    ['test.setTimeout', () => (test as unknown as Untyped).setTimeout(60_000), /test\.use\(\{ timeout \}\)/],
    ['test.info', () => (test as unknown as Untyped).info(), /./],
    ['test.describe.fixme', () => (tapsmithDescribe as unknown as Untyped).fixme('group', () => {}), /test\.describe\.skip/],
    ['test.describe.parallel', () => (tapsmithDescribe as unknown as Untyped).parallel('group', () => {}), /--workers/],
    ['expect.configure', () => (expect as unknown as Untyped).configure({ timeout: 1 }), /timeout/],
    ['expect.extend', () => (expect as unknown as Untyped).extend({}), /./],
  ];

  for (const [api, call, hint] of cases) {
    it(`${api}() throws a clear "not supported yet" error`, () => {
      let caught: unknown;
      try { call(); } catch (err) { caught = err; }
      vitestExpect(caught).toBeInstanceOf(Error);
      const message = (caught as Error).message;
      vitestExpect(message).toContain(`${api}() isn't supported in Tapsmith yet`);
      vitestExpect(message).toContain(DOCS);
      vitestExpect(message).toMatch(hint);
    });
  }

  it('is also present on a test.extend() result', () => {
    const extended = test.extend<{ n: number }>({ n: async ({}, use) => { await use(1); } });
    vitestExpect(() => (extended as unknown as Untyped).step('x', async () => {}))
      .toThrow(/test\.step\(\) isn't supported in Tapsmith yet/);
  });

  it('expect(fn).toPass() suggests expect.poll', () => {
    const assertions = expect(async () => {}) as unknown as Untyped;
    vitestExpect(() => assertions.toPass())
      .toThrow(/expect\(fn\)\.toPass\(\) isn't supported in Tapsmith yet.*expect\.poll/s);
    vitestExpect(() => (expect.soft(async () => {}) as unknown as Untyped).toPass())
      .toThrow(/toPass\(\) isn't supported/);
  });

  it('stubs stay off the enumerable assertion surface', () => {
    vitestExpect(Object.keys(expect(1))).not.toContain('toPass');
  });
});

describe('Playwright locator methods that Tapsmith names differently', () => {
  const handle = new ElementHandle({} as unknown as TapsmithGrpcClient, _text('Sign in'), 5_000) as unknown as Untyped;

  const cases: [string, string][] = [
    ['click', 'tap'],
    ['dblclick', 'doubleTap'],
    ['fill', 'clearAndType'],
    ['textContent', 'getText'],
    ['innerText', 'getText'],
  ];

  for (const [method, replacement] of cases) {
    it(`.${method}() points at .${replacement}()`, () => {
      vitestExpect(() => handle[method]()).toThrow(
        `.${method}() isn't an ElementHandle method in Tapsmith: use .${replacement}() instead.`,
      );
    });
  }

  it('the renamed methods are not enumerable', () => {
    vitestExpect(Object.keys(Object.getPrototypeOf(handle))).not.toContain('click');
  });
});
