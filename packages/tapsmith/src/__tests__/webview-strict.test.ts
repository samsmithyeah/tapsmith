/**
 * Strict mode for WebView locators (PILOT-227).
 *
 * A webview.getBy* locator that resolves to more than one DOM element must
 * throw a StrictModeViolationError on actions, single-element queries, and
 * positive assertions — never silently act on the first match. Positional
 * chains (.first()/.nth()/.last()), count()/all(), and absence checks are
 * exempt, mirroring native locators.
 */
import { describe, expect, it, vi } from 'vitest';
import type { TapsmithGrpcClient } from '../grpc-client.js';
import { WebViewHandle, type WebViewLocatorProbe } from '../webview-handle.js';
import { isStrictModeViolation } from '../element-handle.js';
import { expect as texpect } from '../expect.js';

const TIMEOUT_MS = 400;

interface ProbeMatch {
  tag?: string
  id?: string
  testId?: string
  ariaLabel?: string
  role?: string
  text?: string
  visible?: boolean
}

function probeOf(matches: ProbeMatch[]): WebViewLocatorProbe {
  return {
    count: matches.length,
    visible: matches.map((m) => m.visible ?? true),
    sample: matches.slice(0, 10).map((m) => ({
      tag: m.tag ?? 'div',
      id: m.id ?? '',
      testId: m.testId ?? '',
      ariaLabel: m.ariaLabel ?? '',
      role: m.role ?? '',
      text: m.text ?? '',
    })),
  };
}

/** WebViewHandle with the CDP layer stubbed out: probes come from `matches`,
 * other evaluates are recorded and answered with `evaluateResult`. */
function makeHandle(matches: ProbeMatch[], evaluateResult: unknown = undefined) {
  const handle = new WebViewHandle({} as TapsmithGrpcClient, 0, TIMEOUT_MS);
  const evaluated: string[] = [];
  vi.spyOn(handle, '_probeLocator').mockImplementation(async () => probeOf(matches));
  vi.spyOn(handle, '_evaluate').mockImplementation(async (expression: string) => {
    evaluated.push(expression);
    return evaluateResult;
  });
  return { handle, evaluated };
}

describe('WebView strict mode (PILOT-227)', () => {
  describe('actions', () => {
    it('click() on a locator resolving to 2 elements throws a StrictModeViolationError', async () => {
      const { handle, evaluated } = makeHandle([
        { tag: 'p', text: 'Sign in to continue' },
        { tag: 'button', text: 'Sign in', testId: 'login' },
      ]);
      const err = await handle.getByText('Sign in').click().catch((e: unknown) => e);
      expect(isStrictModeViolation(err)).toBe(true);
      expect((err as Error).message).toContain('strict mode violation: "text=Sign in" resolved to 2 elements');
      expect((err as Error).message).toContain('1) p "Sign in to continue"');
      expect((err as Error).message).toContain('2) button "Sign in"');
      // No click was dispatched to the page.
      expect(evaluated.some((e) => e.includes('.click()'))).toBe(false);
    });

    it('throws immediately on ambiguity instead of waiting out the timeout', async () => {
      const { handle } = makeHandle([{ text: 'A' }, { text: 'A' }]);
      const start = Date.now();
      await expect(handle.getByText('A').click()).rejects.toThrow('strict mode violation');
      expect(Date.now() - start).toBeLessThan(TIMEOUT_MS);
    });

    it('click() proceeds with exactly one match', async () => {
      const { handle, evaluated } = makeHandle([{ tag: 'button', text: 'Sign in' }]);
      await handle.getByText('Sign in').click();
      expect(evaluated.some((e) => e.includes('.click()'))).toBe(true);
    });

    it('suggests unambiguous webview selectors in the violation message', async () => {
      const { handle } = makeHandle([
        { tag: 'button', text: 'Save', testId: 'save-primary' },
        { tag: 'button', text: 'Save', id: 'save2' },
        { tag: 'button', ariaLabel: 'Save draft' },
        { tag: 'span', text: 'Save' },
      ]);
      const err = await handle.getByText('Save').click().catch((e: unknown) => e);
      const message = (err as Error).message;
      expect(message).toContain('aka webview.getByTestId("save-primary")');
      expect(message).toContain('aka webview.locator("#save2")');
      expect(message).toContain('aka webview.getByLabel("Save draft")');
      expect(message).toContain('aka webview.getByText("Save", { exact: true })');
    });

    it('reports the total match count when more elements match than are sampled', async () => {
      const matches = Array.from({ length: 14 }, (_, i) => ({ tag: 'li', text: `Row ${i}` }));
      const { handle } = makeHandle(matches);
      const err = await handle.locator('li').click().catch((e: unknown) => e);
      expect((err as Error).message).toContain('resolved to 14 elements');
      expect((err as Error).message).toContain('… and 4 more');
    });

    it('fill() and textContent() are strict too', async () => {
      const { handle } = makeHandle([{ text: 'X' }, { text: 'X' }]);
      await expect(handle.getByText('X').fill('v')).rejects.toThrow('strict mode violation');
      await expect(handle.getByText('X').textContent()).rejects.toThrow('strict mode violation');
    });

    it('times out with the locator description when nothing matches', async () => {
      const { handle } = makeHandle([]);
      await expect(handle.getByText('Missing').click()).rejects.toThrow(
        `Timed out waiting for "text=Missing" in WebView (${TIMEOUT_MS}ms)`,
      );
    });
  });

  describe('positional chains are exempt', () => {
    it('.first().click() acts on index 0 of an ambiguous match set', async () => {
      const { handle, evaluated } = makeHandle([{ text: 'A' }, { text: 'A' }]);
      await handle.getByText('A').first().click();
      const click = evaluated.find((e) => e.includes('.click()'));
      expect(click).toContain('[0]');
    });

    it('.nth(1) addresses the second match', async () => {
      const { handle, evaluated } = makeHandle([{ text: 'A' }, { text: 'A' }]);
      await handle.getByText('A').nth(1).click();
      const click = evaluated.find((e) => e.includes('.click()'));
      expect(click).toContain('[1]');
    });

    it('.last() addresses the final match via a negative index', async () => {
      const { handle, evaluated } = makeHandle([{ text: 'A' }, { text: 'A' }, { text: 'A' }]);
      await handle.getByText('A').last().click();
      const click = evaluated.find((e) => e.includes('.click()'));
      expect(click).toContain('els.length - 1');
    });

    it('.nth(2) waits and times out when fewer elements match', async () => {
      const { handle } = makeHandle([{ text: 'A' }]);
      await expect(handle.getByText('A').nth(2).click()).rejects.toThrow(
        `Timed out waiting for "text=A >> nth=2" in WebView (${TIMEOUT_MS}ms)`,
      );
    });

    it('nth() rejects non-integer indices', () => {
      const { handle } = makeHandle([]);
      expect(() => handle.getByText('A').nth(1.5)).toThrow('nth(1.5): index must be an integer');
    });
  });

  describe('count() and all() are exempt', () => {
    it('count() returns the full match count without throwing', async () => {
      const { handle } = makeHandle([{ text: 'A' }, { text: 'A' }, { text: 'A' }]);
      expect(await handle.getByText('A').count()).toBe(3);
    });

    it('count() on a positional locator reflects whether the index resolves', async () => {
      const { handle } = makeHandle([{ text: 'A' }, { text: 'A' }]);
      expect(await handle.getByText('A').nth(1).count()).toBe(1);
      expect(await handle.getByText('A').nth(5).count()).toBe(0);
    });

    it('all() returns one positionally-narrowed locator per match', async () => {
      const { handle } = makeHandle([{ text: 'A' }, { text: 'A' }]);
      const all = await handle.getByText('A').all();
      expect(all.map((l) => l._nthIndex)).toEqual([0, 1]);
      expect(all.map((l) => l._selector)).toEqual(['text=A >> nth=0', 'text=A >> nth=1']);
    });
  });

  describe('isVisible()', () => {
    it('throws on an ambiguous locator', async () => {
      const { handle } = makeHandle([{ text: 'A' }, { text: 'A' }]);
      await expect(handle.getByText('A').isVisible()).rejects.toThrow('strict mode violation');
    });

    it('returns the target visibility for positional locators', async () => {
      const { handle } = makeHandle([{ text: 'A', visible: false }, { text: 'A', visible: true }]);
      expect(await handle.getByText('A').first().isVisible()).toBe(false);
      expect(await handle.getByText('A').last().isVisible()).toBe(true);
    });

    it('returns false when nothing matches', async () => {
      const { handle } = makeHandle([]);
      expect(await handle.getByText('A').isVisible()).toBe(false);
    });
  });

  describe('assertions', () => {
    it('toBeVisible() throws a strict violation on an ambiguous locator', async () => {
      const { handle } = makeHandle([{ text: 'A' }, { text: 'A' }]);
      const err = await texpect(handle.getByText('A')).toBeVisible().catch((e: unknown) => e);
      expect(isStrictModeViolation(err)).toBe(true);
    });

    it('toBeVisible() passes for a positional locator over an ambiguous set', async () => {
      const { handle } = makeHandle([{ text: 'A' }, { text: 'A' }]);
      await texpect(handle.getByText('A').first()).toBeVisible();
    });

    it('toBeHidden() is an absence check — evaluates over all matches without throwing', async () => {
      const { handle } = makeHandle([
        { text: 'A', visible: false },
        { text: 'A', visible: false },
      ]);
      await texpect(handle.getByText('A')).toBeHidden();
    });

    it('not.toBeVisible() is exempt and passes when every match is hidden', async () => {
      const { handle } = makeHandle([
        { text: 'A', visible: false },
        { text: 'A', visible: false },
      ]);
      await texpect(handle.getByText('A')).not.toBeVisible();
    });

    it('toBeHidden() fails while any match is still visible', async () => {
      const { handle } = makeHandle([
        { text: 'A', visible: false },
        { text: 'A', visible: true },
      ]);
      await expect(
        texpect(handle.getByText('A')).toBeHidden({ timeout: 100 }),
      ).rejects.toThrow('to be hidden in WebView');
    });

    it('toExist() throws a strict violation on an ambiguous locator', async () => {
      const { handle } = makeHandle([{ text: 'A' }, { text: 'A' }]);
      await expect(texpect(handle.getByText('A')).toExist()).rejects.toThrow('strict mode violation');
    });

    it('not.toExist() is exempt and passes when nothing matches', async () => {
      const { handle } = makeHandle([]);
      await texpect(handle.getByText('A')).not.toExist();
    });

    it('toHaveText() propagates a strict violation instead of burning the timeout', async () => {
      const { handle } = makeHandle([{ text: 'A' }, { text: 'A' }]);
      const start = Date.now();
      const err = await texpect(handle.getByText('A')).toHaveText('A').catch((e: unknown) => e);
      expect(isStrictModeViolation(err)).toBe(true);
      expect(Date.now() - start).toBeLessThan(TIMEOUT_MS);
    });

    it('toHaveText() passes with a single match', async () => {
      const { handle } = makeHandle([{ tag: 'h1', text: 'Welcome' }], 'Welcome');
      await texpect(handle.getByText('Welcome')).toHaveText('Welcome');
    });
  });
});
