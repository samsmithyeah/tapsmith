import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ElementHandle, StrictModeViolationError, isStrictModeViolation } from '../element-handle.js';
import { TraceCollector, type TraceCapture } from '../trace/trace-collector.js';
import type { AnyTraceEvent, ActionTraceEvent } from '../trace/types.js';
import { isAbortError } from '../abort.js';
import { type Selector, _text, _textContains, _role, _className, _id, _testId, formatSelector, selectorToProto } from '../selectors.js';
import type {
  TapsmithGrpcClient,
  FindElementsResponse,
  ActionResponse,
  ElementInfo,
  ScreenshotResponse,
} from '../grpc-client.js';

// ─── Mock helpers ───

function makeElementInfo(overrides: Partial<ElementInfo> = {}): ElementInfo {
  return {
    elementId: 'el-1',
    className: 'android.widget.TextView',
    text: 'Hello',
    contentDescription: '',
    resourceId: '',
    enabled: true,
    visible: true,
    clickable: true,
    focusable: false,
    scrollable: false,
    hint: '',
    checked: false,
    selected: false,
    focused: false,
    role: '',
    viewportRatio: 1.0,
    ...overrides,
  };
}

function successResponse(): ActionResponse {
  return {
    requestId: '1',
    success: true,
    errorType: '',
    errorMessage: '',
    screenshot: Buffer.alloc(0),
  };
}

function failureResponse(msg = 'Action failed'): ActionResponse {
  return {
    requestId: '1',
    success: false,
    errorType: 'ERROR',
    errorMessage: msg,
    screenshot: Buffer.alloc(0),
  };
}

function makeFindElementsResponse(elements: ElementInfo[]): FindElementsResponse {
  return { requestId: '1', elements, errorMessage: '' };
}

function screenshotResponse(): ScreenshotResponse {
  return {
    requestId: '1',
    success: true,
    data: Buffer.from('PNG_DATA'),
    errorMessage: '',
  };
}

function makeMockClient(overrides: Partial<TapsmithGrpcClient> = {}): TapsmithGrpcClient {
  return {
    findElement: vi.fn(async () => ({
      requestId: '1',
      found: true,
      element: makeElementInfo(),
      errorMessage: '',
    })),
    findElements: vi.fn(async () => makeFindElementsResponse([makeElementInfo()])),
    tap: vi.fn(async () => successResponse()),
    longPress: vi.fn(async () => successResponse()),
    typeText: vi.fn(async () => successResponse()),
    clearAndType: vi.fn(async () => successResponse()),
    clearText: vi.fn(async () => successResponse()),
    scroll: vi.fn(async () => successResponse()),
    doubleTap: vi.fn(async () => successResponse()),
    dragAndDrop: vi.fn(async () => successResponse()),
    selectOption: vi.fn(async () => successResponse()),
    pinchZoom: vi.fn(async () => successResponse()),
    focus: vi.fn(async () => successResponse()),
    blur: vi.fn(async () => successResponse()),
    highlight: vi.fn(async () => successResponse()),
    takeElementScreenshot: vi.fn(async () => screenshotResponse()),
    takeScreenshot: vi.fn(async () => screenshotResponse()),
    ...overrides,
  } as unknown as TapsmithGrpcClient;
}

// ─── Constructor ───

describe('ElementHandle constructor', () => {
  it('stores client, selector, and timeout', () => {
    const client = makeMockClient();
    const sel = _text('Test');
    const handle = new ElementHandle(client, sel, 5000);
    expect(handle._client).toBe(client);
    expect(handle._selector).toBe(sel);
    expect(handle._timeoutMs).toBe(5000);
  });
});

// ─── getBy* scoping ───

describe('getBy* scoping', () => {
  it('creates a child handle with nested selector', () => {
    const client = makeMockClient();
    const parent = new ElementHandle(client, _role('list'), 5000);

    const child = parent.getByText('Item 1', { exact: true });
    expect(child._selector.kind.type).toBe('text');
    expect(child._selector.parent).toBeDefined();
    expect(child._selector.parent!.kind.type).toBe('role');
  });

  it('scoped selector serializes with parent', () => {
    const client = makeMockClient();
    const parent = new ElementHandle(
      client,
      _className('android.widget.ListView'),
      5000,
    );

    const child = parent.getByText('Row', { exact: true });
    expect(selectorToProto(child._selector)).toEqual({
      text: 'Row',
      parent: { className: 'android.widget.ListView' },
    });
  });

  it('substring getByText (default) builds a textContains child', () => {
    const client = makeMockClient();
    const parent = new ElementHandle(client, _role('list'), 5000);
    const child = parent.getByText('partial');
    expect(selectorToProto(child._selector)).toEqual({
      textContains: 'partial',
      parent: { role: { role: 'list', name: '' } },
    });
  });

  it('preserves client and timeout in child handle', () => {
    const client = makeMockClient();
    const parent = new ElementHandle(client, _role('container'), 7000);
    const child = parent.getByText('inner', { exact: true });
    expect(child._client).toBe(client);
    expect(child._timeoutMs).toBe(7000);
  });

  it('supports multi-level scoping', () => {
    const client = makeMockClient();
    const root = new ElementHandle(client, _role('page'), 5000);
    const mid = root.getByRole('section');
    const leaf = mid.getByText('Label', { exact: true });

    expect(leaf._selector.parent).toBeDefined();
    expect(leaf._selector.parent!.parent).toBeDefined();
    expect(leaf._selector.parent!.parent!.kind.type).toBe('role');
  });

  it('getByDescription, getByPlaceholder, getByTestId, locator scope correctly', () => {
    const client = makeMockClient();
    const parent = new ElementHandle(client, _role('list'), 5000);

    expect(parent.getByDescription('Close')._selector.kind).toEqual({
      type: 'contentDesc',
      value: 'Close',
    });
    expect(parent.getByPlaceholder('Search')._selector.kind).toEqual({
      type: 'hint',
      value: 'Search',
    });
    expect(parent.getByTestId('btn')._selector.kind).toEqual({
      type: 'testId',
      value: 'btn',
    });
    expect(parent.locator({ id: 'foo' })._selector.kind).toEqual({
      type: 'id',
      value: 'foo',
    });
    expect(parent.locator({ id: 'foo' })._selector.parent).toBeDefined();
  });

  describe('scoping off a modified handle (geometric containment)', () => {
    // Two stacked dialogs; one button geometrically inside each.
    const dialogs: ElementInfo[] = [
      makeElementInfo({ elementId: 'd1', text: 'Dialog A', bounds: { left: 0, top: 0, right: 200, bottom: 100 } }),
      makeElementInfo({ elementId: 'd2', text: 'Dialog B', bounds: { left: 0, top: 100, right: 200, bottom: 200 } }),
    ];
    const buttons: ElementInfo[] = [
      makeElementInfo({ elementId: 'b1', text: 'Submit', role: 'button', bounds: { left: 10, top: 10, right: 90, bottom: 40 } }),
      makeElementInfo({ elementId: 'b2', text: 'Submit', role: 'button', bounds: { left: 10, top: 110, right: 90, bottom: 140 } }),
    ];
    // Leaf text element, geometrically inside b1 (for the re-scoping test).
    const labels: ElementInfo[] = [
      makeElementInfo({ elementId: 't1', text: 'OK', bounds: { left: 20, top: 15, right: 80, bottom: 35 } }),
    ];

    function scopedClient(): TapsmithGrpcClient {
      const findElements = vi.fn(async (selector: Selector) => {
        const desc = formatSelector(selector);
        if (desc.includes('getByRole')) return makeFindElementsResponse(buttons);
        if (desc.includes('getByText')) return makeFindElementsResponse(labels);
        return makeFindElementsResponse(dialogs);
      });
      return makeMockClient({ findElements });
    }

    it('scopes a getBy* child to the .first() parent by containment', async () => {
      const device = scopedClient();
      const button = new ElementHandle(device, _testId('dialog'), 5000)
        .first()
        .getByRole('button', { name: 'Submit' });
      const el = await button.find();
      expect(el.elementId).toBe('b1');
    });

    it('scopes to the .last() parent', async () => {
      const device = scopedClient();
      const button = new ElementHandle(device, _testId('dialog'), 5000)
        .last()
        .getByRole('button', { name: 'Submit' });
      const el = await button.find();
      expect(el.elementId).toBe('b2');
    });

    it('unions children across all parents matched by a filter', async () => {
      const device = scopedClient();
      // Both dialogs contain "Dialog", so the scope spans both → both buttons.
      const count = await new ElementHandle(device, _testId('dialog'), 5000)
        .filter({ hasText: 'Dialog' })
        .getByRole('button')
        .count();
      expect(count).toBe(2);
    });

    it('honors the parent scope on the assertion path (not a global query)', async () => {
      const device = scopedClient();
      // Scoped to the first dialog → only b1 is in scope. Assertions resolve
      // through _resolveForAssertion, which must apply the scope rather than
      // querying buttons globally (which would yield b1 + b2).
      const scoped = new ElementHandle(device, _testId('dialog'), 5000)
        .first()
        .getByRole('button');
      const els = await scoped._resolveForAssertion(5000, false);
      expect(els.map((e) => e.elementId)).toEqual(['b1']);
    });

    it('supports re-scoping off an already-scoped handle', async () => {
      const device = scopedClient();
      // dialog.first() → scoped buttons; .first() of those → scope again.
      const handle = new ElementHandle(device, _testId('dialog'), 5000)
        .first()
        .getByRole('button')
        .first()
        .getByText('OK');
      const el = await handle.find();
      expect(el.elementId).toBe('t1');
    });

    it('returns 0 from count() (does not throw) when the scoped parent is absent', async () => {
      const device = makeMockClient({
        findElements: vi.fn(async () => makeFindElementsResponse([])),
      });
      const count = await new ElementHandle(device, _testId('dialog'), 5000)
        .first()
        .getByRole('button')
        .count();
      expect(count).toBe(0);
    });
  });
});

// ─── find() ───

describe('find()', () => {
  it('returns ElementInfo when found', async () => {
    const info = makeElementInfo({ text: 'Found it' });
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([info])),
    });
    const handle = new ElementHandle(client, _text('Found it'), 5000);
    const result = await handle.find();
    expect(result.text).toBe('Found it');
  });

  it('throws when element is not found', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([])),
    });
    const handle = new ElementHandle(client, _text('Missing'), 300);
    await expect(handle.find()).rejects.toThrow(/was not found/);
  });

  it('throws with selector description in the error message', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([])),
    });
    const handle = new ElementHandle(client, _text('Gone'), 300);
    await expect(handle.find()).rejects.toThrow('getByText("Gone", { exact: true })');
  });

  it('polls findElements with a capped per-tick budget', async () => {
    const findElements = vi.fn(async () => makeFindElementsResponse([makeElementInfo()]));
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, _text('X'), 3000);
    await handle.find();
    expect(findElements).toHaveBeenCalledWith(handle._selector, 250);
  });

  it('throws StrictModeViolationError when multiple elements match', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([
        makeElementInfo({ text: 'Sign in to continue' }),
        makeElementInfo({ text: 'Sign in' }),
      ])),
    });
    const handle = new ElementHandle(client, _textContains('Sign in'), 5000);
    await expect(handle.find()).rejects.toThrow(/^strict mode violation/);
  });
});

// ─── exists() ───

describe('exists()', () => {
  it('returns true when element is found', async () => {
    const client = makeMockClient();
    const handle = new ElementHandle(client, _text('Present'), 5000);
    const result = await handle.exists();
    expect(result).toBe(true);
  });

  it('returns false when element is not found', async () => {
    const client = makeMockClient({
      findElement: vi.fn(async () => ({
        requestId: '1',
        found: false,
        errorMessage: '',
      })),
    });
    const handle = new ElementHandle(client, _text('Absent'), 5000);
    const result = await handle.exists();
    expect(result).toBe(false);
  });
});

// ─── Action methods ───

describe('tap()', () => {
  it('waits for enabled then delegates to client.tap with remaining timeout', async () => {
    const tap = vi.fn(async () => successResponse());
    const client = makeMockClient({ tap });
    const sel = _text('Button');
    const handle = new ElementHandle(client, sel, 4000);
    await handle.tap();
    // findElements is called once by _waitForEnabled to check enabled state
    // (and that the match is unique — strict mode, PILOT-226)
    expect(client.findElements).toHaveBeenCalled();
    expect(tap).toHaveBeenCalledWith(sel, expect.any(Number));
    // Remaining timeout should be close to 4000 (minus the findElement round-trip)
    const remaining = (tap.mock.calls[0] as unknown as [unknown, number])[1];
    expect(remaining).toBeLessThanOrEqual(4000);
    expect(remaining).toBeGreaterThan(3000);
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      tap: vi.fn(async () => failureResponse('Tap target not found')),
    });
    const handle = new ElementHandle(client, _text('Missing'), 5000);
    await expect(handle.tap()).rejects.toThrow('Tap target not found');
  });

  it('throws default message when errorMessage is empty', async () => {
    const client = makeMockClient({
      tap: vi.fn(async () => failureResponse('')),
    });
    const handle = new ElementHandle(client, _text('X'), 5000);
    await expect(handle.tap()).rejects.toThrow('Tap failed');
  });

  it('waits for a disabled element to become enabled before tapping', async () => {
    let callCount = 0;
    const findElements = vi.fn(async () => {
      callCount++;
      return makeFindElementsResponse([makeElementInfo({ enabled: callCount >= 3 })]);
    });
    const tap = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElements, tap });
    const handle = new ElementHandle(client, _text('Submit'), 5000);
    await handle.tap();
    expect(callCount).toBeGreaterThanOrEqual(3);
    expect(tap).toHaveBeenCalled();
  });

  it('throws "disabled" when element is found but stays disabled', async () => {
    const findElements = vi.fn(async () => makeFindElementsResponse([makeElementInfo({ enabled: false })]));
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, _text('Submit'), 500);
    await expect(handle.tap()).rejects.toThrow(/is disabled/);
  });

  it('throws "not found" when element never appears', async () => {
    const findElements = vi.fn(async () => makeFindElementsResponse([]));
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, _text('Ghost'), 500);
    await expect(handle.tap()).rejects.toThrow(/was not found/);
  });

  it('throws StrictModeViolationError listing all matches when the selector is ambiguous', async () => {
    const elements = [
      makeElementInfo({ text: 'Sign in to continue to DreamSpinner', role: 'text', bounds: { left: 44, top: 210, right: 436, bottom: 260 } }),
      makeElementInfo({ text: 'Sign in', role: 'button', bounds: { left: 44, top: 640, right: 436, bottom: 712 } }),
    ];
    const tap = vi.fn(async () => successResponse());
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(elements)),
      tap,
    });
    const handle = new ElementHandle(client, _textContains('Sign in'), 5000);
    const err = await handle.tap().then(
      () => { throw new Error('expected tap to reject'); },
      (e: unknown) => e,
    );
    expect(isStrictModeViolation(err)).toBe(true);
    expect(err).toBeInstanceOf(StrictModeViolationError);
    expect((err as StrictModeViolationError).elements).toHaveLength(2);
    expect((err as Error).message).toBe(
      'strict mode violation: getByText("Sign in") resolved to 2 elements:\n' +
      '    1) text "Sign in to continue to DreamSpinner" [44,210][436,260] aka device.getByText("Sign in to continue to DreamSpinner", { exact: true })\n' +
      '    2) button "Sign in" [44,640][436,712] aka device.getByRole("button", { name: "Sign in" })\n' +
      'Hint: use { exact: true }, getByRole(role, { name }), getByTestId(), or .first()/.nth()/.last() to target a single element.',
    );
    // Strict violations must throw immediately — no polling out the timeout
    expect(client.findElements).toHaveBeenCalledTimes(1);
    expect(tap).not.toHaveBeenCalled();
  });

  it('.first() disambiguates an ambiguous selector', async () => {
    const elements = [
      makeElementInfo({ text: 'Sign in to continue', resourceId: 'subtitle' }),
      makeElementInfo({ text: 'Sign in', resourceId: 'button' }),
    ];
    const tap = vi.fn(async () => successResponse());
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(elements)),
      tap,
    });
    const handle = new ElementHandle(client, _textContains('Sign in'), 5000);
    await handle.first().tap();
    expect(tap).toHaveBeenCalled();
  });

  it('with timeout 0 skips the enabled wait and still invokes tap', async () => {
    const findElements = vi.fn(async () => makeFindElementsResponse([makeElementInfo({ enabled: true })]));
    const tap = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElements, tap });
    const handle = new ElementHandle(client, _text('Now'), 0);
    await handle.tap();
    expect(findElements).not.toHaveBeenCalled();
    expect(tap).toHaveBeenCalledWith(expect.anything(), 0);
  });

  it('propagates non-"not found" errors from findElements instead of masking them as timeout', async () => {
    // Regression: the old catch-all swallowed gRPC failures and surfaced
    // them as "Element X was not found after waiting Nms", obscuring the
    // real cause (e.g. daemon crashed, network down). Only no-match errors
    // should keep the poll loop alive; everything else must propagate.
    const findElements = vi.fn(async () => {
      throw new Error('14 UNAVAILABLE: No connection established');
    });
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, _text('Anything'), 5000);
    await expect(handle.tap()).rejects.toThrow(/UNAVAILABLE/);
  });

  it('floors the action budget when the element becomes enabled near the deadline', async () => {
    // Use fake timers so the test doesn't burn ~2s of real wall time. The
    // mock's setTimeout and _waitForEnabled's Date.now()/setTimeout both run
    // against the faked clock.
    vi.useFakeTimers();
    try {
      const findElements = vi.fn(async () => {
        // Burn almost the whole 2000ms budget before reporting enabled.
        await new Promise((r) => setTimeout(r, 1900));
        return makeFindElementsResponse([makeElementInfo({ enabled: true })]);
      });
      const tap = vi.fn(async () => successResponse());
      const client = makeMockClient({ findElements, tap });
      const handle = new ElementHandle(client, _text('Late'), 2000);

      const tapPromise = handle.tap();
      // Drain microtasks + advance the fake clock past the simulated 1900ms
      // findElement delay so _waitForEnabled observes the enabled element
      // with ~100ms remaining.
      await vi.advanceTimersByTimeAsync(2000);
      await tapPromise;

      // Action budget must be >= 1000ms so client.tap has time to execute,
      // even though only ~100ms of the shared deadline remains.
      const actionBudget = (tap.mock.calls[0] as unknown as [unknown, number])[1];
      expect(actionBudget).toBeGreaterThanOrEqual(1000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('longPress()', () => {
  it('waits for enabled then delegates to client.longPress', async () => {
    const longPress = vi.fn(async () => successResponse());
    const client = makeMockClient({ longPress });
    const sel = _text('Item');
    const handle = new ElementHandle(client, sel, 5000);
    await handle.longPress(1000);
    expect(longPress).toHaveBeenCalledWith(sel, 1000, expect.any(Number));
    const remaining = (longPress.mock.calls[0] as unknown as [unknown, unknown, number])[2];
    expect(remaining).toBeLessThanOrEqual(5000);
    expect(remaining).toBeGreaterThan(4000);
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      longPress: vi.fn(async () => failureResponse('Long press failed')),
    });
    const handle = new ElementHandle(client, _text('X'), 5000);
    await expect(handle.longPress()).rejects.toThrow('Long press failed');
  });
});

describe('type()', () => {
  it('delegates to client.typeText', async () => {
    const typeText = vi.fn(async () => successResponse());
    const client = makeMockClient({ typeText });
    const sel = _text('Input');
    const handle = new ElementHandle(client, sel, 5000);
    await handle.type('hello');
    expect(typeText).toHaveBeenCalledWith(sel, 'hello', expect.any(Number), 0);
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      typeText: vi.fn(async () => failureResponse('Type failed')),
    });
    const handle = new ElementHandle(client, _text('X'), 5000);
    await expect(handle.type('abc')).rejects.toThrow('Type failed');
  });
});

describe('clearAndType()', () => {
  it('delegates to client.clearAndType', async () => {
    const clearAndType = vi.fn(async () => successResponse());
    const client = makeMockClient({ clearAndType });
    const sel = _text('Field');
    const handle = new ElementHandle(client, sel, 5000);
    await handle.clearAndType('new value');
    expect(clearAndType).toHaveBeenCalledWith(sel, 'new value', expect.any(Number), 0);
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      clearAndType: vi.fn(async () => failureResponse()),
    });
    const handle = new ElementHandle(client, _text('X'), 5000);
    await expect(handle.clearAndType('x')).rejects.toThrow('Action failed');
  });
});

describe('clear()', () => {
  it('delegates to client.clearText', async () => {
    const clearText = vi.fn(async () => successResponse());
    const client = makeMockClient({ clearText });
    const sel = _text('Field');
    const handle = new ElementHandle(client, sel, 5000);
    await handle.clear();
    expect(clearText).toHaveBeenCalledWith(sel, expect.any(Number));
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      clearText: vi.fn(async () => failureResponse('Cannot clear')),
    });
    const handle = new ElementHandle(client, _text('X'), 5000);
    await expect(handle.clear()).rejects.toThrow('Cannot clear');
  });
});

describe('scroll()', () => {
  it('delegates to client.scroll', async () => {
    const scroll = vi.fn(async () => successResponse());
    const client = makeMockClient({ scroll });
    const sel = _text('List');
    const handle = new ElementHandle(client, sel, 5000);
    await handle.scroll('down', { distance: 500 });
    // timeoutMs is the resolution-remaining budget (deadline - now), which is
    // 5000 only if <1ms elapsed during the async find — assert the type, not an
    // exact value, matching the sibling action tests above.
    expect(scroll).toHaveBeenCalledWith(sel, 'down', {
      distance: 500,
      timeoutMs: expect.any(Number),
    });
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      scroll: vi.fn(async () => failureResponse('Scroll failed')),
    });
    const handle = new ElementHandle(client, _text('X'), 5000);
    await expect(handle.scroll('up')).rejects.toThrow('Scroll failed');
  });
});

// ─── Info accessors ───

describe('getText()', () => {
  it('returns text from found element', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([makeElementInfo({ text: 'Content here' })])),
    });
    const handle = new ElementHandle(client, _text('X'), 5000);
    const result = await handle.getText();
    expect(result).toBe('Content here');
  });
});

describe('isVisible()', () => {
  it('returns visibility from found element', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([makeElementInfo({ visible: false })])),
    });
    const handle = new ElementHandle(client, _text('X'), 5000);
    expect(await handle.isVisible()).toBe(false);
  });
});

describe('isEnabled()', () => {
  it('returns enabled state from found element', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([makeElementInfo({ enabled: false })])),
    });
    const handle = new ElementHandle(client, _text('X'), 5000);
    expect(await handle.isEnabled()).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// New Locator API tests (PILOT-13 through PILOT-17)
// ═══════════════════════════════════════════════════════════════════════

const threeItems: ElementInfo[] = [
  makeElementInfo({ elementId: 'el-1', text: 'Apple', resourceId: 'item_1', bounds: { left: 0, top: 0, right: 100, bottom: 50 } }),
  makeElementInfo({ elementId: 'el-2', text: 'Banana', resourceId: 'item_2', bounds: { left: 0, top: 50, right: 100, bottom: 100 } }),
  makeElementInfo({ elementId: 'el-3', text: 'Cherry', resourceId: 'item_3', bounds: { left: 0, top: 100, right: 100, bottom: 150 } }),
];

// ─── count() (PILOT-14) ───

describe('count()', () => {
  it('returns the number of matching elements', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
    });
    const handle = new ElementHandle(client, _role('listitem'), 5000);
    expect(await handle.count()).toBe(3);
  });

  it('returns 0 when no elements match', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([])),
    });
    const handle = new ElementHandle(client, _role('listitem'), 5000);
    expect(await handle.count()).toBe(0);
  });

  it('passes timeout to findElements', async () => {
    const findElements = vi.fn(async () => makeFindElementsResponse([]));
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, _role('listitem'), 7000);
    await handle.count();
    expect(findElements).toHaveBeenCalledWith(handle._selector, 7000);
  });
});

// ─── all() (PILOT-13) ───

describe('all()', () => {
  it('returns an array of ElementHandles for each match', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
    });
    const handle = new ElementHandle(client, _role('listitem'), 5000);
    const items = await handle.all();
    expect(items).toHaveLength(3);
    items.forEach((item) => {
      expect(item).toBeInstanceOf(ElementHandle);
      expect(item._client).toBe(client);
      expect(item._timeoutMs).toBe(5000);
    });
  });

  it('returns empty array when no elements match', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([])),
    });
    const handle = new ElementHandle(client, _role('listitem'), 5000);
    const items = await handle.all();
    expect(items).toEqual([]);
  });

  it('returned handles resolve to the correct element via nth index', async () => {
    const findElements = vi.fn(async () => makeFindElementsResponse(threeItems));
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, _role('listitem'), 5000);
    const items = await handle.all();

    // Each handle's find() should resolve to the correct element by index
    const second = await items[1].find();
    expect(second.text).toBe('Banana');
  });

  it('handles from all() throw when re-indexed with first/last/nth', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
    });
    const handle = new ElementHandle(client, _role('listitem'), 5000);
    const items = await handle.all();

    expect(() => items[2].first()).toThrow('first() cannot be called on a handle returned by all()');
    expect(() => items[0].last()).toThrow('last() cannot be called on a handle returned by all()');
    expect(() => items[1].nth(0)).toThrow('nth() cannot be called on a handle returned by all()');
  });
});

// ─── first(), last(), nth() (PILOT-15) ───

describe('first()', () => {
  it('returns a new ElementHandle (lazy — does not resolve)', () => {
    const client = makeMockClient();
    const handle = new ElementHandle(client, _role('listitem'), 5000);
    const first = handle.first();
    expect(first).toBeInstanceOf(ElementHandle);
    expect(first).not.toBe(handle);
    expect(first._selector).toBe(handle._selector);
    // findElements should not have been called yet
    expect(client.findElements).not.toHaveBeenCalled();
  });

  it('find() resolves to the first matching element', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
    });
    const handle = new ElementHandle(client, _role('listitem'), 5000);
    const result = await handle.first().find();
    expect(result.text).toBe('Apple');
  });

  it('exists() returns true when at least one element matches', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
    });
    const handle = new ElementHandle(client, _role('listitem'), 5000);
    expect(await handle.first().exists()).toBe(true);
  });

  it('exists() returns false when no elements match', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([])),
    });
    const handle = new ElementHandle(client, _role('listitem'), 5000);
    expect(await handle.first().exists()).toBe(false);
  });
});

describe('last()', () => {
  it('find() resolves to the last matching element', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
    });
    const handle = new ElementHandle(client, _role('listitem'), 5000);
    const result = await handle.last().find();
    expect(result.text).toBe('Cherry');
  });

  it('throws when no elements match', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([])),
    });
    const handle = new ElementHandle(client, _role('listitem'), 5000);
    await expect(handle.last().find()).rejects.toThrow('nth(-1)');
  });
});

describe('nth()', () => {
  it('find() resolves to the element at the given index', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
    });
    const handle = new ElementHandle(client, _role('listitem'), 5000);
    const result = await handle.nth(1).find();
    expect(result.text).toBe('Banana');
  });

  it('supports negative indices (counting from end)', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
    });
    const handle = new ElementHandle(client, _role('listitem'), 5000);
    const result = await handle.nth(-2).find();
    expect(result.text).toBe('Banana');
  });

  it('throws when index is out of bounds', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
    });
    const handle = new ElementHandle(client, _role('listitem'), 5000);
    await expect(handle.nth(5).find()).rejects.toThrow('nth(5)');
  });

  it('throws when negative index is out of bounds', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
    });
    const handle = new ElementHandle(client, _role('listitem'), 5000);
    await expect(handle.nth(-4).find()).rejects.toThrow('nth(-4)');
  });

  it('tap() on nth handle uses resolved element selector', async () => {
    const tap = vi.fn(async () => successResponse());
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
      tap,
    });
    const handle = new ElementHandle(client, _role('listitem'), 5000);
    await handle.nth(1).tap();
    // Banana has resourceId 'item_2', so the resolved selector should be id('item_2')
    const calledSelector = (tap.mock.calls[0] as unknown[])[0] as Selector;
    expect(selectorToProto(calledSelector)).toEqual({ resourceId: 'item_2' });
  });

  it('longPress() on nth handle uses resolved element selector', async () => {
    const longPress = vi.fn(async () => successResponse());
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
      longPress,
    });
    const handle = new ElementHandle(client, _role('listitem'), 5000);
    await handle.nth(2).longPress(500);
    const calledSelector = (longPress.mock.calls[0] as unknown[])[0] as Selector;
    expect(selectorToProto(calledSelector)).toEqual({ resourceId: 'item_3' });
  });

  it('type() on nth handle uses resolved element selector', async () => {
    const typeText = vi.fn(async () => successResponse());
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
      typeText,
    });
    const handle = new ElementHandle(client, _role('listitem'), 5000);
    await handle.nth(0).type('hello');
    const calledSelector = (typeText.mock.calls[0] as unknown[])[0] as Selector;
    expect(selectorToProto(calledSelector)).toEqual({ resourceId: 'item_1' });
  });
});

// ─── filter() (PILOT-16) ───

describe('filter()', () => {
  it('returns a new lazy ElementHandle', () => {
    const client = makeMockClient();
    const handle = new ElementHandle(client, _role('listitem'), 5000);
    const filtered = handle.filter({ hasText: 'Apple' });
    expect(filtered).toBeInstanceOf(ElementHandle);
    expect(filtered).not.toBe(handle);
    expect(client.findElements).not.toHaveBeenCalled();
  });

  describe('hasText', () => {
    it('filters by substring match', async () => {
      const client = makeMockClient({
        findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
      });
      const handle = new ElementHandle(client, _role('listitem'), 5000);
      const count = await handle.filter({ hasText: 'an' }).count();
      expect(count).toBe(1); // Only "Banana" contains "an"
    });

    it('filters by RegExp', async () => {
      const client = makeMockClient({
        findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
      });
      const handle = new ElementHandle(client, _role('listitem'), 5000);
      const count = await handle.filter({ hasText: /^[AB]/ }).count();
      expect(count).toBe(2); // Apple and Banana
    });

    it('find() returns the first matching element', async () => {
      const client = makeMockClient({
        findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
      });
      const handle = new ElementHandle(client, _role('listitem'), 5000);
      const result = await handle.filter({ hasText: 'Cherry' }).find();
      expect(result.text).toBe('Cherry');
    });
  });

  describe('hasNotText', () => {
    it('excludes elements matching the text', async () => {
      const client = makeMockClient({
        findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
      });
      const handle = new ElementHandle(client, _role('listitem'), 5000);
      const count = await handle.filter({ hasNotText: 'Apple' }).count();
      expect(count).toBe(2); // Banana and Cherry
    });

    it('excludes elements matching a RegExp', async () => {
      const client = makeMockClient({
        findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
      });
      const handle = new ElementHandle(client, _role('listitem'), 5000);
      const items = await handle.filter({ hasNotText: /rry$/ }).all();
      expect(items).toHaveLength(2); // Apple and Banana
    });
  });

  describe('has (child selector)', () => {
    it('keeps elements that contain a descendant matching the selector', async () => {
      const parentElements: ElementInfo[] = [
        makeElementInfo({ elementId: 'p1', text: 'Card 1', bounds: { left: 0, top: 0, right: 200, bottom: 100 } }),
        makeElementInfo({ elementId: 'p2', text: 'Card 2', bounds: { left: 0, top: 100, right: 200, bottom: 200 } }),
      ];
      const childElements: ElementInfo[] = [
        makeElementInfo({ elementId: 'c1', text: 'Premium', bounds: { left: 10, top: 10, right: 90, bottom: 40 } }),
      ];

      const findElements = vi.fn(async (selector: Selector) => {
        const proto = selectorToProto(selector);
        // Child selector is _text('Premium').within(_role('listitem')), so it has a parent
        if (proto.parent) return makeFindElementsResponse(childElements);
        return makeFindElementsResponse(parentElements);
      });
      const client = makeMockClient({ findElements });
      const handle = new ElementHandle(client, _role('listitem'), 5000);
      const premium = new ElementHandle(client, _text('Premium'), 5000);
      const count = await handle.filter({ has: premium }).count();
      // Only Card 1 contains the "Premium" child (bounds overlap)
      expect(count).toBe(1);
    });
  });

  describe('hasNot (child selector)', () => {
    it('excludes elements that contain a descendant matching the selector', async () => {
      const parentElements: ElementInfo[] = [
        makeElementInfo({ elementId: 'p1', text: 'Card 1', bounds: { left: 0, top: 0, right: 200, bottom: 100 } }),
        makeElementInfo({ elementId: 'p2', text: 'Card 2', bounds: { left: 0, top: 100, right: 200, bottom: 200 } }),
      ];
      const childElements: ElementInfo[] = [
        makeElementInfo({ elementId: 'c1', text: 'Disabled', bounds: { left: 10, top: 110, right: 90, bottom: 140 } }),
      ];

      const findElements = vi.fn(async (selector: Selector) => {
        const proto = selectorToProto(selector);
        // Child selector is _text('Disabled').within(_role('listitem')), so it has a parent
        if (proto.parent) return makeFindElementsResponse(childElements);
        return makeFindElementsResponse(parentElements);
      });
      const client = makeMockClient({ findElements });
      const handle = new ElementHandle(client, _role('listitem'), 5000);
      const disabled = new ElementHandle(client, _text('Disabled'), 5000);
      const count = await handle.filter({ hasNot: disabled }).count();
      // Card 2 contains the "Disabled" child, so only Card 1 remains
      expect(count).toBe(1);
    });
  });

  describe('combined filters', () => {
    it('applies hasText and hasNotText together', async () => {
      const items: ElementInfo[] = [
        makeElementInfo({ elementId: 'e1', text: 'Apple Pie' }),
        makeElementInfo({ elementId: 'e2', text: 'Apple Sauce' }),
        makeElementInfo({ elementId: 'e3', text: 'Banana Split' }),
      ];
      const client = makeMockClient({
        findElements: vi.fn(async () => makeFindElementsResponse(items)),
      });
      const handle = new ElementHandle(client, _role('listitem'), 5000);
      const result = await handle
        .filter({ hasText: 'Apple' })
        .filter({ hasNotText: 'Pie' })
        .count();
      expect(result).toBe(1); // Only "Apple Sauce"
    });
  });

  it('filter() composes with nth()', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
    });
    const handle = new ElementHandle(client, _role('listitem'), 5000);
    // Filter to items not containing "Apple", then pick the last
    const result = await handle.filter({ hasNotText: 'Apple' }).last().find();
    expect(result.text).toBe('Cherry');
  });
});

// ─── and() (PILOT-17) ───

describe('and()', () => {
  it('returns elements matching both selectors (intersection by elementId)', async () => {
    const buttonsEls: ElementInfo[] = [
      makeElementInfo({ elementId: 'e1', text: 'Submit', resourceId: 'btn1' }),
      makeElementInfo({ elementId: 'e2', text: 'Cancel', resourceId: 'btn2' }),
    ];
    const submitEls: ElementInfo[] = [
      makeElementInfo({ elementId: 'e1', text: 'Submit', resourceId: 'btn1' }),
    ];

    const findElements = vi.fn(async (selector: Selector) => {
      const proto = selectorToProto(selector);
      if (proto.text === 'Submit') return makeFindElementsResponse(submitEls);
      return makeFindElementsResponse(buttonsEls);
    });
    const client = makeMockClient({ findElements });

    const buttons = new ElementHandle(client, _role('button'), 5000);
    const submit = new ElementHandle(client, _text('Submit'), 5000);
    const result = await buttons.and(submit).count();
    expect(result).toBe(1);
  });

  it('returns empty when no elements match both', async () => {
    const findElements = vi.fn(async (selector: Selector) => {
      const proto = selectorToProto(selector);
      if (proto.text) {
        return makeFindElementsResponse([
          makeElementInfo({ elementId: 'e3', text: 'Other' }),
        ]);
      }
      return makeFindElementsResponse([
        makeElementInfo({ elementId: 'e1', text: 'Submit' }),
      ]);
    });
    const client = makeMockClient({ findElements });

    const buttons = new ElementHandle(client, _role('button'), 5000);
    const other = new ElementHandle(client, _text('Other'), 5000);
    expect(await buttons.and(other).count()).toBe(0);
  });

  it('and() with tap() resolves and taps the matching element', async () => {
    const tap = vi.fn(async () => successResponse());
    const intersectEl = makeElementInfo({ elementId: 'e1', text: 'Submit', resourceId: 'btn-submit' });
    const findElements = vi.fn(async () => makeFindElementsResponse([intersectEl]));
    const client = makeMockClient({ findElements, tap });

    const buttons = new ElementHandle(client, _role('button'), 5000);
    const submit = new ElementHandle(client, _text('Submit'), 5000);
    await buttons.and(submit).tap();

    const calledSelector = (tap.mock.calls[0] as unknown[])[0] as Selector;
    expect(selectorToProto(calledSelector)).toEqual({ resourceId: 'btn-submit' });
  });
});

// ─── or() (PILOT-17) ───

describe('or()', () => {
  it('returns elements matching either selector (union, deduped)', async () => {
    const okEls: ElementInfo[] = [
      makeElementInfo({ elementId: 'e1', text: 'OK' }),
    ];
    const confirmEls: ElementInfo[] = [
      makeElementInfo({ elementId: 'e2', text: 'Confirm' }),
    ];

    const findElements = vi.fn(async (selector: Selector) => {
      const proto = selectorToProto(selector);
      if (proto.text === 'OK') return makeFindElementsResponse(okEls);
      return makeFindElementsResponse(confirmEls);
    });
    const client = makeMockClient({ findElements });

    const ok = new ElementHandle(client, _text('OK'), 5000);
    const confirm = new ElementHandle(client, _text('Confirm'), 5000);
    expect(await ok.or(confirm).count()).toBe(2);
  });

  it('deduplicates elements present in both selectors', async () => {
    const sharedEl = makeElementInfo({ elementId: 'e1', text: 'Submit' });
    const findElements = vi.fn(async () => makeFindElementsResponse([sharedEl]));
    const client = makeMockClient({ findElements });

    const a = new ElementHandle(client, _role('button'), 5000);
    const b = new ElementHandle(client, _text('Submit'), 5000);
    expect(await a.or(b).count()).toBe(1);
  });

  it('or() with tap() uses the first available element', async () => {
    const tap = vi.fn(async () => successResponse());
    const okEl = makeElementInfo({ elementId: 'e1', text: 'OK', resourceId: '' });
    const findElements = vi.fn(async (selector: Selector) => {
      const proto = selectorToProto(selector);
      if (proto.text === 'OK') return makeFindElementsResponse([okEl]);
      return makeFindElementsResponse([]); // "Confirm" not present
    });
    const client = makeMockClient({ findElements, tap });

    const ok = new ElementHandle(client, _text('OK'), 5000);
    const confirm = new ElementHandle(client, _text('Confirm'), 5000);
    await ok.or(confirm).tap();

    const calledSelector = (tap.mock.calls[0] as unknown[])[0] as Selector;
    // OK has no resourceId or contentDescription, so falls back to text selector
    expect(selectorToProto(calledSelector)).toEqual({ text: 'OK' });
  });

  it('or() throws when neither selector matches', async () => {
    const findElements = vi.fn(async () => makeFindElementsResponse([]));
    const client = makeMockClient({ findElements });

    const a = new ElementHandle(client, _text('OK'), 5000);
    const b = new ElementHandle(client, _text('Confirm'), 5000);
    await expect(a.or(b).find()).rejects.toThrow('Element not found');
  });
});

// ─── Chaining multiple and()/or() ───

describe('chaining and()', () => {
  it('a.and(b).and(c) matches elements in all three', async () => {
    const shared = makeElementInfo({ elementId: 'e1', text: 'Submit' });
    const findElements = vi.fn(async (selector: Selector) => {
      const proto = selectorToProto(selector);
      if (proto.text === 'B') {
        return makeFindElementsResponse([
          shared,
          makeElementInfo({ elementId: 'e2', text: 'Other' }),
        ]);
      }
      if (proto.text === 'C') {
        return makeFindElementsResponse([shared]);
      }
      // A
      return makeFindElementsResponse([
        shared,
        makeElementInfo({ elementId: 'e3', text: 'Extra' }),
      ]);
    });
    const client = makeMockClient({ findElements });

    const a = new ElementHandle(client, _text('A'), 5000);
    const b = new ElementHandle(client, _text('B'), 5000);
    const c = new ElementHandle(client, _text('C'), 5000);
    const count = await a.and(b).and(c).count();
    expect(count).toBe(1);
    const result = await a.and(b).and(c).first().find();
    expect(result.text).toBe('Submit');
  });
});

describe('chaining or()', () => {
  it('a.or(b).or(c) matches elements in any of the three', async () => {
    const findElements = vi.fn(async (selector: Selector) => {
      const proto = selectorToProto(selector);
      if (proto.text === 'A') return makeFindElementsResponse([makeElementInfo({ elementId: 'e1', text: 'A' })]);
      if (proto.text === 'B') return makeFindElementsResponse([makeElementInfo({ elementId: 'e2', text: 'B' })]);
      if (proto.text === 'C') return makeFindElementsResponse([makeElementInfo({ elementId: 'e3', text: 'C' })]);
      return makeFindElementsResponse([]);
    });
    const client = makeMockClient({ findElements });

    const a = new ElementHandle(client, _text('A'), 5000);
    const b = new ElementHandle(client, _text('B'), 5000);
    const c = new ElementHandle(client, _text('C'), 5000);
    const count = await a.or(b).or(c).count();
    expect(count).toBe(3);
  });
});

// ─── Composition / integration ───

describe('method composition', () => {
  it('filter().first() works correctly', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
    });
    const handle = new ElementHandle(client, _role('listitem'), 5000);
    const result = await handle.filter({ hasNotText: 'Apple' }).first().find();
    expect(result.text).toBe('Banana');
  });

  it('or().nth() works correctly', async () => {
    const aEls = [makeElementInfo({ elementId: 'e1', text: 'A' })];
    const bEls = [makeElementInfo({ elementId: 'e2', text: 'B' })];
    const findElements = vi.fn(async (selector: Selector) => {
      const proto = selectorToProto(selector);
      if (proto.text === 'A') return makeFindElementsResponse(aEls);
      return makeFindElementsResponse(bEls);
    });
    const client = makeMockClient({ findElements });

    const a = new ElementHandle(client, _text('A'), 5000);
    const b = new ElementHandle(client, _text('B'), 5000);
    const result = await a.or(b).nth(1).find();
    expect(result.text).toBe('B');
  });

  it('all() handles resolve correctly for iteration with assertions', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
    });
    const handle = new ElementHandle(client, _role('listitem'), 5000);
    const items = await handle.all();

    // Simulate the Playwright-style pattern: iterate and check visibility
    for (const item of items) {
      const info = await item.find();
      expect(info.visible).toBe(true);
    }
  });

  it('action methods on unmodified handle pass the direct selector to the agent', async () => {
    const tap = vi.fn(async () => successResponse());
    const client = makeMockClient({ tap });
    const sel = _text('Button');
    const handle = new ElementHandle(client, sel, 5000);

    await handle.tap();

    // findElements runs once for the strict-mode uniqueness check
    // (PILOT-226), but the action itself still receives the raw selector —
    // the agent re-resolves it on-device.
    expect(client.findElements).toHaveBeenCalled();
    // tap forwards the remaining budget from _waitForEnabled(), which is
    // `deadline - Date.now()` — on a slow tick CI run that can be 4999ms
    // rather than exactly 5000. Assert the call shape, not the exact value.
    expect(tap).toHaveBeenCalledWith(sel, expect.any(Number));
  });

  it('action selector falls back to contentDescription when no resourceId', async () => {
    const tap = vi.fn(async () => successResponse());
    const elWithDesc = makeElementInfo({
      elementId: 'e1',
      text: '',
      resourceId: '',
      contentDescription: 'Close button',
    });
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([elWithDesc])),
      tap,
    });
    const handle = new ElementHandle(client, _role('button'), 5000);
    await handle.first().tap();

    const calledSelector = (tap.mock.calls[0] as unknown[])[0] as Selector;
    expect(selectorToProto(calledSelector)).toEqual({ contentDesc: 'Close button' });
  });

  it('filter().and() applies filter before intersection, not after', async () => {
    // a has elements e1 ("Apple"), e2 ("Banana"), e3 ("Cherry")
    // b has elements e2 ("Banana")
    // a.filter({ hasText: "an" }).and(b) should:
    //   1. Filter a → [e2 "Banana"] (only one contains "an")
    //   2. Intersect with b → [e2 "Banana"]
    // NOT: intersect first → [e2], then filter → [e2] (same result here but different semantics)
    const aEls = [
      makeElementInfo({ elementId: 'e1', text: 'Apple' }),
      makeElementInfo({ elementId: 'e2', text: 'Banana' }),
      makeElementInfo({ elementId: 'e3', text: 'Cherry' }),
    ];
    const bEls = [
      makeElementInfo({ elementId: 'e2', text: 'Banana' }),
      makeElementInfo({ elementId: 'e3', text: 'Cherry' }),
    ];
    const findElements = vi.fn(async (selector: Selector) => {
      const proto = selectorToProto(selector);
      if (proto.text === 'B') return makeFindElementsResponse(bEls);
      return makeFindElementsResponse(aEls);
    });
    const client = makeMockClient({ findElements });

    const a = new ElementHandle(client, _text('A'), 5000);
    const b = new ElementHandle(client, _text('B'), 5000);

    // Without the fix, filter would be applied after and(), giving wrong results
    const count = await a.filter({ hasText: 'an' }).and(b).count();
    expect(count).toBe(1);
    const result = await a.filter({ hasText: 'an' }).and(b).first().find();
    expect(result.text).toBe('Banana');
  });

  it('action throws when element has no identifying properties', async () => {
    const tap = vi.fn(async () => successResponse());
    const bareEl = makeElementInfo({
      elementId: 'e1',
      text: '',
      resourceId: '',
      contentDescription: '',
    });
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([bareEl])),
      tap,
    });
    const handle = new ElementHandle(client, _role('button'), 5000);
    await expect(handle.first().tap()).rejects.toThrow('Cannot target element for action');
  });

  it('doubleTap() on nth handle uses resolved element selector', async () => {
    const doubleTap = vi.fn(async () => successResponse());
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
      doubleTap,
    });
    const handle = new ElementHandle(client, _role('listitem'), 5000);
    await handle.nth(1).doubleTap();
    const calledSelector = (doubleTap.mock.calls[0] as unknown[])[0] as Selector;
    expect(selectorToProto(calledSelector)).toEqual({ resourceId: 'item_2' });
  });

  it('a.and(b).filter(F) applies filter after intersection', async () => {
    // a has e1 ("Apple"), e2 ("Banana"), e3 ("Cherry")
    // b has e1 ("Apple"), e2 ("Banana")
    // a.and(b) = [e1, e2], then .filter({ hasText: "an" }) = [e2 "Banana"]
    // This is DIFFERENT from a.filter(F).and(b) which is:
    //   a.filter(F) = [e2], then AND b = [e2]
    const aEls = [
      makeElementInfo({ elementId: 'e1', text: 'Apple' }),
      makeElementInfo({ elementId: 'e2', text: 'Banana' }),
      makeElementInfo({ elementId: 'e3', text: 'Cherry' }),
    ];
    const bEls = [
      makeElementInfo({ elementId: 'e1', text: 'Apple' }),
      makeElementInfo({ elementId: 'e2', text: 'Banana' }),
    ];
    const findElements = vi.fn(async (selector: Selector) => {
      const proto = selectorToProto(selector);
      if (proto.text === 'B') return makeFindElementsResponse(bEls);
      return makeFindElementsResponse(aEls);
    });
    const client = makeMockClient({ findElements });

    const a = new ElementHandle(client, _text('A'), 5000);
    const b = new ElementHandle(client, _text('B'), 5000);

    // a.and(b).filter(F): intersection first, then filter
    const result = await a.and(b).filter({ hasText: 'an' }).count();
    expect(result).toBe(1);
    const el = await a.and(b).filter({ hasText: 'an' }).first().find();
    expect(el.text).toBe('Banana');

    // Verify it's different from a.filter(F).and(b) when results would differ:
    // a.filter({ hasNotText: 'Apple' }) = [e2 Banana, e3 Cherry]
    // then .and(b) = intersection with [e1, e2] = [e2 Banana]
    const altResult = await a.filter({ hasNotText: 'Apple' }).and(b).count();
    expect(altResult).toBe(1); // Only Banana in both
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Element Actions tests (PILOT-2: PILOT-18 through PILOT-28)
// ═══════════════════════════════════════════════════════════════════════

// ─── doubleTap() (PILOT-18) ───

describe('doubleTap()', () => {
  it('delegates to client.doubleTap with selector and timeout', async () => {
    const doubleTap = vi.fn(async () => successResponse());
    const client = makeMockClient({ doubleTap });
    const sel = _text('Button');
    const handle = new ElementHandle(client, sel, 4000);
    await handle.doubleTap();
    expect(doubleTap).toHaveBeenCalledWith(sel, expect.any(Number), 0);
  });

  it('passes intervalMs to client.doubleTap when specified', async () => {
    const doubleTap = vi.fn(async () => successResponse());
    const client = makeMockClient({ doubleTap });
    const sel = _text('Button');
    const handle = new ElementHandle(client, sel, 4000);
    await handle.doubleTap({ intervalMs: 100 });
    expect(doubleTap).toHaveBeenCalledWith(sel, expect.any(Number), 100);
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      doubleTap: vi.fn(async () => failureResponse('Double tap target not found')),
    });
    const handle = new ElementHandle(client, _text('Missing'), 5000);
    await expect(handle.doubleTap()).rejects.toThrow('Double tap target not found');
  });

  it('throws default message when errorMessage is empty', async () => {
    const client = makeMockClient({
      doubleTap: vi.fn(async () => failureResponse('')),
    });
    const handle = new ElementHandle(client, _text('X'), 5000);
    await expect(handle.doubleTap()).rejects.toThrow('Double tap failed');
  });

  it('unmodified handle passes the direct selector to the agent', async () => {
    const doubleTap = vi.fn(async () => successResponse());
    const client = makeMockClient({ doubleTap });
    const sel = _text('Button');
    const handle = new ElementHandle(client, sel, 5000);
    await handle.doubleTap();
    // findElements runs once for the strict-mode uniqueness check (PILOT-226)
    expect(client.findElements).toHaveBeenCalled();
    expect(doubleTap).toHaveBeenCalledWith(sel, expect.any(Number), 0);
  });
});

// ─── dragTo() (PILOT-19) ───

describe('dragTo()', () => {
  it('delegates to client.dragAndDrop with source and target selectors', async () => {
    const dragAndDrop = vi.fn(async () => successResponse());
    const client = makeMockClient({ dragAndDrop });
    const sourceSel = _text('Item 1');
    const targetSel = _text('Drop Zone');
    const source = new ElementHandle(client, sourceSel, 5000);
    const target = new ElementHandle(client, targetSel, 5000);
    await source.dragTo(target);
    expect(dragAndDrop).toHaveBeenCalledWith(sourceSel, targetSel, expect.any(Number));
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      dragAndDrop: vi.fn(async () => failureResponse('Drag failed')),
    });
    const source = new ElementHandle(client, _text('Item'), 5000);
    const target = new ElementHandle(client, _text('Zone'), 5000);
    await expect(source.dragTo(target)).rejects.toThrow('Drag failed');
  });

  it('throws default message when errorMessage is empty', async () => {
    const client = makeMockClient({
      dragAndDrop: vi.fn(async () => failureResponse('')),
    });
    const source = new ElementHandle(client, _text('Item'), 5000);
    const target = new ElementHandle(client, _text('Zone'), 5000);
    await expect(source.dragTo(target)).rejects.toThrow('Drag and drop failed');
  });

  it('resolves selectors for modified handles', async () => {
    const dragAndDrop = vi.fn(async () => successResponse());
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
      dragAndDrop,
    });
    const source = new ElementHandle(client, _role('listitem'), 5000);
    const target = new ElementHandle(client, _role('listitem'), 5000);
    await source.first().dragTo(target.last());
    const calledSource = (dragAndDrop.mock.calls[0] as unknown[])[0] as Selector;
    const calledTarget = (dragAndDrop.mock.calls[0] as unknown[])[1] as Selector;
    expect(selectorToProto(calledSource)).toEqual({ resourceId: 'item_1' });
    expect(selectorToProto(calledTarget)).toEqual({ resourceId: 'item_3' });
  });
});

// ─── setChecked() (PILOT-20) ───

describe('setChecked()', () => {
  it('taps when current state differs from desired state and verifies', async () => {
    const tap = vi.fn(async () => successResponse());
    let callCount = 0;
    const client = makeMockClient({
      findElements: vi.fn(async () => {
        callCount++;
        // First call: unchecked, second call (verification): checked
        const checked = callCount > 1;
        return makeFindElementsResponse([makeElementInfo({ checked, text: 'Switch', resourceId: 'sw1' })]);
      }),
      tap,
    });
    const handle = new ElementHandle(client, _text('Switch'), 5000);
    await handle.setChecked(true);
    expect(tap).toHaveBeenCalled();
  });

  it('does not tap when current state matches desired state', async () => {
    const tap = vi.fn(async () => successResponse());
    const el = makeElementInfo({ checked: true, text: 'Switch', resourceId: 'sw1' });
    const findResult = { requestId: '1', found: true, element: el, errorMessage: '' };
    const client = makeMockClient({
      findElement: vi.fn(async () => findResult),
      findElements: vi.fn(async () => makeFindElementsResponse([el])),
      tap,
    });
    const handle = new ElementHandle(client, _text('Switch'), 5000);
    await handle.setChecked(true);
    expect(tap).not.toHaveBeenCalled();
  });

  it('taps to uncheck when element is checked and desired is false', async () => {
    const tap = vi.fn(async () => successResponse());
    let callCount = 0;
    const makEl = () => { callCount++; return makeElementInfo({ checked: callCount <= 1, text: 'Switch', resourceId: 'sw1' }); };
    const client = makeMockClient({
      findElement: vi.fn(async () => ({ requestId: '1', found: true, element: makEl(), errorMessage: '' })),
      findElements: vi.fn(async () => makeFindElementsResponse([makEl()])),
      tap,
    });
    const handle = new ElementHandle(client, _text('Switch'), 5000);
    await handle.setChecked(false);
    expect(tap).toHaveBeenCalled();
  });

  it('throws when tap fails', async () => {
    const el = makeElementInfo({ checked: false, text: 'Switch', resourceId: 'sw1' });
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([el])),
      tap: vi.fn(async () => failureResponse('Tap failed')),
    });
    const handle = new ElementHandle(client, _text('Switch'), 5000);
    await expect(handle.setChecked(true)).rejects.toThrow('Tap failed');
  });

  it('throws when state does not change after tap', async () => {
    const tap = vi.fn(async () => successResponse());
    // Always returns unchecked — simulates a non-responsive checkbox
    const el = makeElementInfo({ checked: false, text: 'Switch', resourceId: 'sw1' });
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([el])),
      tap,
    });
    // Use a short timeout so the retry loop exhausts quickly in the test
    const handle = new ElementHandle(client, _text('Switch'), 1500);
    await expect(handle.setChecked(true)).rejects.toThrow('did not change after tap');
    // With retry, tap should have been called more than once
    expect(tap.mock.calls.length).toBeGreaterThanOrEqual(1);
  }, 10000);

  it('works on modified handles', async () => {
    const tap = vi.fn(async () => successResponse());
    let callCount = 0;
    const client = makeMockClient({
      findElements: vi.fn(async () => {
        callCount++;
        const items = [
          makeElementInfo({ elementId: 'e1', text: 'Switch 1', resourceId: 'sw1', checked: true }),
          makeElementInfo({
            elementId: 'e2',
            text: 'Switch 2',
            resourceId: 'sw2',
            // First call: unchecked, second call (verification): checked
            checked: callCount > 1,
          }),
        ];
        return makeFindElementsResponse(items);
      }),
      tap,
    });
    const handle = new ElementHandle(client, _role('switch'), 5000);
    await handle.nth(1).setChecked(true);
    expect(tap).toHaveBeenCalled();
    const calledSelector = (tap.mock.calls[0] as unknown[])[0] as Selector;
    expect(selectorToProto(calledSelector)).toEqual({ resourceId: 'sw2' });
  });
});

// ─── selectOption() (PILOT-21) ───

describe('selectOption()', () => {
  it('delegates to client.selectOption with string option', async () => {
    const selectOption = vi.fn(async () => successResponse());
    const client = makeMockClient({ selectOption });
    const sel = _text('Dropdown');
    const handle = new ElementHandle(client, sel, 5000);
    await handle.selectOption('Option 2');
    expect(selectOption).toHaveBeenCalledWith(sel, 'Option 2', expect.any(Number));
  });

  it('delegates to client.selectOption with index option', async () => {
    const selectOption = vi.fn(async () => successResponse());
    const client = makeMockClient({ selectOption });
    const sel = _text('Dropdown');
    const handle = new ElementHandle(client, sel, 5000);
    await handle.selectOption({ index: 1 });
    expect(selectOption).toHaveBeenCalledWith(sel, { index: 1 }, expect.any(Number));
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      selectOption: vi.fn(async () => failureResponse('Option not found')),
    });
    const handle = new ElementHandle(client, _text('Dropdown'), 5000);
    await expect(handle.selectOption('Missing')).rejects.toThrow('Option not found');
  });

  it('throws default message when errorMessage is empty', async () => {
    const client = makeMockClient({
      selectOption: vi.fn(async () => failureResponse('')),
    });
    const handle = new ElementHandle(client, _text('X'), 5000);
    await expect(handle.selectOption('A')).rejects.toThrow('Select option failed');
  });
});

// ─── screenshot() (PILOT-22) ───

describe('screenshot()', () => {
  it('delegates to client.takeElementScreenshot and returns Buffer', async () => {
    const takeElementScreenshot = vi.fn(async () => screenshotResponse());
    const client = makeMockClient({ takeElementScreenshot });
    const sel = _text('Image');
    const handle = new ElementHandle(client, sel, 5000);
    const result = await handle.screenshot();
    expect(takeElementScreenshot).toHaveBeenCalledWith(sel, expect.any(Number));
    expect(result).toEqual(Buffer.from('PNG_DATA'));
  });

  it('resolves selector for modified handles', async () => {
    const takeElementScreenshot = vi.fn(async () => screenshotResponse());
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
      takeElementScreenshot,
    });
    const handle = new ElementHandle(client, _role('image'), 5000);
    await handle.first().screenshot();
    const calledSelector = (takeElementScreenshot.mock.calls[0] as unknown[])[0] as Selector;
    expect(selectorToProto(calledSelector)).toEqual({ resourceId: 'item_1' });
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      takeElementScreenshot: vi.fn(async () => ({
        requestId: '1',
        success: false,
        data: Buffer.alloc(0),
        errorMessage: 'Screenshot capture failed',
      })),
    });
    const handle = new ElementHandle(client, _text('Image'), 5000);
    await expect(handle.screenshot()).rejects.toThrow('Screenshot capture failed');
  });

  it('throws default message when errorMessage is empty', async () => {
    const client = makeMockClient({
      takeElementScreenshot: vi.fn(async () => ({
        requestId: '1',
        success: false,
        data: Buffer.alloc(0),
        errorMessage: '',
      })),
    });
    const handle = new ElementHandle(client, _text('Image'), 5000);
    await expect(handle.screenshot()).rejects.toThrow('Element screenshot failed');
  });
});

// ─── boundingBox() (PILOT-23) ───

describe('boundingBox()', () => {
  it('returns bounding box from element bounds', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([
        makeElementInfo({ bounds: { left: 10, top: 20, right: 110, bottom: 70 } }),
      ])),
    });
    const handle = new ElementHandle(client, _text('Header'), 5000);
    const box = await handle.boundingBox();
    expect(box).toEqual({ x: 10, y: 20, width: 100, height: 50 });
  });

  it('returns null when element has no bounds', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([
        makeElementInfo({ bounds: undefined }),
      ])),
    });
    const handle = new ElementHandle(client, _text('Header'), 5000);
    const box = await handle.boundingBox();
    expect(box).toBeNull();
  });

  it('works on modified handles', async () => {
    const items = [
      makeElementInfo({ elementId: 'e1', text: 'A', resourceId: 'a', bounds: { left: 0, top: 0, right: 50, bottom: 50 } }),
      makeElementInfo({ elementId: 'e2', text: 'B', resourceId: 'b', bounds: { left: 50, top: 0, right: 150, bottom: 80 } }),
    ];
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(items)),
    });
    const handle = new ElementHandle(client, _role('button'), 5000);
    const box = await handle.last().boundingBox();
    expect(box).toEqual({ x: 50, y: 0, width: 100, height: 80 });
  });
});

// ─── pinchIn() / pinchOut() (PILOT-24) ───

describe('pinchIn()', () => {
  it('delegates to client.pinchZoom with default scale 0.5', async () => {
    const pinchZoom = vi.fn(async () => successResponse());
    const client = makeMockClient({ pinchZoom });
    const sel = _text('Map');
    const handle = new ElementHandle(client, sel, 5000);
    await handle.pinchIn();
    expect(pinchZoom).toHaveBeenCalledWith(sel, 0.5, expect.any(Number));
  });

  it('accepts custom scale', async () => {
    const pinchZoom = vi.fn(async () => successResponse());
    const client = makeMockClient({ pinchZoom });
    const sel = _text('Map');
    const handle = new ElementHandle(client, sel, 5000);
    await handle.pinchIn({ scale: 0.3 });
    expect(pinchZoom).toHaveBeenCalledWith(sel, 0.3, expect.any(Number));
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      pinchZoom: vi.fn(async () => failureResponse('Pinch failed')),
    });
    const handle = new ElementHandle(client, _text('Map'), 5000);
    await expect(handle.pinchIn()).rejects.toThrow('Pinch failed');
  });

  it('throws default message when errorMessage is empty', async () => {
    const client = makeMockClient({
      pinchZoom: vi.fn(async () => failureResponse('')),
    });
    const handle = new ElementHandle(client, _text('X'), 5000);
    await expect(handle.pinchIn()).rejects.toThrow('Pinch in failed');
  });
});

describe('pinchOut()', () => {
  it('delegates to client.pinchZoom with default scale 2.0', async () => {
    const pinchZoom = vi.fn(async () => successResponse());
    const client = makeMockClient({ pinchZoom });
    const sel = _text('Map');
    const handle = new ElementHandle(client, sel, 5000);
    await handle.pinchOut();
    expect(pinchZoom).toHaveBeenCalledWith(sel, 2.0, expect.any(Number));
  });

  it('accepts custom scale', async () => {
    const pinchZoom = vi.fn(async () => successResponse());
    const client = makeMockClient({ pinchZoom });
    const sel = _text('Map');
    const handle = new ElementHandle(client, sel, 5000);
    await handle.pinchOut({ scale: 3.0 });
    expect(pinchZoom).toHaveBeenCalledWith(sel, 3.0, expect.any(Number));
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      pinchZoom: vi.fn(async () => failureResponse('')),
    });
    const handle = new ElementHandle(client, _text('X'), 5000);
    await expect(handle.pinchOut()).rejects.toThrow('Pinch out failed');
  });
});

// ─── focus() / blur() (PILOT-25) ───

describe('focus()', () => {
  it('delegates to client.focus with selector and timeout', async () => {
    const focus = vi.fn(async () => successResponse());
    const client = makeMockClient({ focus });
    const sel = _text('Email');
    const handle = new ElementHandle(client, sel, 5000);
    await handle.focus();
    expect(focus).toHaveBeenCalledWith(sel, expect.any(Number));
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      focus: vi.fn(async () => failureResponse('Cannot focus')),
    });
    const handle = new ElementHandle(client, _text('X'), 5000);
    await expect(handle.focus()).rejects.toThrow('Cannot focus');
  });

  it('throws default message when errorMessage is empty', async () => {
    const client = makeMockClient({
      focus: vi.fn(async () => failureResponse('')),
    });
    const handle = new ElementHandle(client, _text('X'), 5000);
    await expect(handle.focus()).rejects.toThrow('Focus failed');
  });

  it('unmodified handle passes the direct selector to the agent', async () => {
    const focus = vi.fn(async () => successResponse());
    const client = makeMockClient({ focus });
    const sel = _text('Input');
    const handle = new ElementHandle(client, sel, 5000);
    await handle.focus();
    // findElements runs once for the strict-mode uniqueness check (PILOT-226)
    expect(client.findElements).toHaveBeenCalled();
    expect(focus).toHaveBeenCalledWith(sel, expect.any(Number));
  });
});

describe('blur()', () => {
  it('delegates to client.blur with selector and timeout', async () => {
    const blur = vi.fn(async () => successResponse());
    const client = makeMockClient({ blur });
    const sel = _text('Email');
    const handle = new ElementHandle(client, sel, 5000);
    await handle.blur();
    expect(blur).toHaveBeenCalledWith(sel, expect.any(Number));
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      blur: vi.fn(async () => failureResponse('Cannot blur')),
    });
    const handle = new ElementHandle(client, _text('X'), 5000);
    await expect(handle.blur()).rejects.toThrow('Cannot blur');
  });

  it('throws default message when errorMessage is empty', async () => {
    const client = makeMockClient({
      blur: vi.fn(async () => failureResponse('')),
    });
    const handle = new ElementHandle(client, _text('X'), 5000);
    await expect(handle.blur()).rejects.toThrow('Blur failed');
  });
});

// ─── isChecked() (PILOT-26) ───

describe('isChecked()', () => {
  it('returns true when element is checked', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([makeElementInfo({ checked: true })])),
    });
    const handle = new ElementHandle(client, _text('Switch'), 5000);
    expect(await handle.isChecked()).toBe(true);
  });

  it('returns false when element is not checked', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([makeElementInfo({ checked: false })])),
    });
    const handle = new ElementHandle(client, _text('Switch'), 5000);
    expect(await handle.isChecked()).toBe(false);
  });
});

// ─── inputValue() (PILOT-27) ───

describe('inputValue()', () => {
  it('returns the text value of the element', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([makeElementInfo({ text: 'user@example.com' })])),
    });
    const handle = new ElementHandle(client, _text('Email'), 5000);
    expect(await handle.inputValue()).toBe('user@example.com');
  });

  it('returns empty string when field is empty', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([makeElementInfo({ text: '' })])),
    });
    const handle = new ElementHandle(client, _text('Email'), 5000);
    expect(await handle.inputValue()).toBe('');
  });
});

// ─── highlight() (PILOT-28) ───

describe('highlight()', () => {
  it('delegates to client.highlight with selector and timeout', async () => {
    const highlight = vi.fn(async () => successResponse());
    const client = makeMockClient({ highlight });
    const sel = _text('Submit');
    const handle = new ElementHandle(client, sel, 5000);
    await handle.highlight();
    expect(highlight).toHaveBeenCalledWith(sel, undefined, expect.any(Number));
  });

  it('passes durationMs option', async () => {
    const highlight = vi.fn(async () => successResponse());
    const client = makeMockClient({ highlight });
    const sel = _text('Submit');
    const handle = new ElementHandle(client, sel, 5000);
    await handle.highlight({ durationMs: 2000 });
    expect(highlight).toHaveBeenCalledWith(sel, 2000, expect.any(Number));
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      highlight: vi.fn(async () => failureResponse('Highlight failed')),
    });
    const handle = new ElementHandle(client, _text('X'), 5000);
    await expect(handle.highlight()).rejects.toThrow('Highlight failed');
  });

  it('throws default message when errorMessage is empty', async () => {
    const client = makeMockClient({
      highlight: vi.fn(async () => failureResponse('')),
    });
    const handle = new ElementHandle(client, _text('X'), 5000);
    await expect(handle.highlight()).rejects.toThrow('Highlight failed');
  });
});

// ─── waitFor ───

describe('waitFor', () => {
  it('resolves immediately when element is already visible (default state)', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([
        makeElementInfo({ visible: true }),
      ])),
    });
    const handle = new ElementHandle(client, _text('Hello'), 5000);
    await handle.waitFor();
  });

  it('resolves immediately for state "attached" when element exists', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([
        makeElementInfo({ visible: false }),
      ])),
    });
    const handle = new ElementHandle(client, _text('Hello'), 5000);
    await handle.waitFor({ state: 'attached' });
  });

  it('resolves immediately for state "hidden" when element does not exist', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([])),
    });
    const handle = new ElementHandle(client, _text('Hello'), 5000);
    await handle.waitFor({ state: 'hidden' });
  });

  it('resolves for state "hidden" when element exists but is not visible', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([
        makeElementInfo({ visible: false }),
      ])),
    });
    const handle = new ElementHandle(client, _text('Hello'), 5000);
    await handle.waitFor({ state: 'hidden' });
  });

  it('resolves immediately for state "detached" when element does not exist', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([])),
    });
    const handle = new ElementHandle(client, _text('Hello'), 5000);
    await handle.waitFor({ state: 'detached' });
  });

  it('polls until element becomes visible', async () => {
    let callCount = 0;
    const client = makeMockClient({
      findElements: vi.fn(async () => {
        callCount++;
        if (callCount < 3) return makeFindElementsResponse([]);
        return makeFindElementsResponse([makeElementInfo({ visible: true })]);
      }),
    });
    const handle = new ElementHandle(client, _text('Hello'), 5000);
    await handle.waitFor({ state: 'visible' });
    expect(callCount).toBeGreaterThanOrEqual(3);
  });

  it('aborts the poll loop promptly when the client abort signal fires (PILOT-222)', async () => {
    const ac = new AbortController();
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([])),
      _getAbortSignal: vi.fn(() => ac.signal),
    } as Partial<TapsmithGrpcClient>);
    // Long timeout: only the abort can end this wait inside vitest's budget.
    const handle = new ElementHandle(client, _text('Hello'), 60_000);
    const wait = handle.waitFor({ state: 'visible' });
    setTimeout(() => ac.abort(), 20);
    // Must surface the abort, NOT the "did not reach state" timeout error.
    await expect(wait).rejects.toSatisfy(isAbortError);
  });

  it('polls until element becomes detached', async () => {
    let callCount = 0;
    const client = makeMockClient({
      findElements: vi.fn(async () => {
        callCount++;
        if (callCount < 3) return makeFindElementsResponse([makeElementInfo()]);
        return makeFindElementsResponse([]);
      }),
    });
    const handle = new ElementHandle(client, _text('Hello'), 5000);
    await handle.waitFor({ state: 'detached' });
    expect(callCount).toBeGreaterThanOrEqual(3);
  });

  it('throws after timeout when state is not reached', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([])),
    });
    const handle = new ElementHandle(client, _text('Hello'), 500);
    await expect(handle.waitFor({ state: 'visible', timeout: 500 }))
      .rejects.toThrow(/did not reach state "visible" after 500ms/);
  });

  it('respects custom timeout option', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([
        makeElementInfo({ visible: false }),
      ])),
    });
    const handle = new ElementHandle(client, _text('Hello'), 30000);
    const start = Date.now();
    await expect(handle.waitFor({ state: 'visible', timeout: 300 }))
      .rejects.toThrow(/did not reach state "visible"/);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000);
  });

  it('propagates infrastructure errors instead of polling', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => { throw new Error('gRPC unavailable'); }),
    });
    const handle = new ElementHandle(client, _text('Hello'), 5000);
    await expect(handle.waitFor()).rejects.toThrow('gRPC unavailable');
  });

  it('works with .first() modifier', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([
        makeElementInfo({ elementId: 'a', visible: true }),
        makeElementInfo({ elementId: 'b', visible: true }),
      ])),
    });
    const handle = new ElementHandle(client, _text('Hello'), 5000).first();
    await handle.waitFor({ state: 'visible' });
  });

  it('respects nthIndex — only checks the targeted element', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([
        makeElementInfo({ elementId: 'a', visible: false }),
        makeElementInfo({ elementId: 'b', visible: true }),
      ])),
    });
    // .first() targets index 0 which is NOT visible
    const handle = new ElementHandle(client, _text('Hello'), 500).first();
    await expect(handle.waitFor({ state: 'visible', timeout: 500 }))
      .rejects.toThrow(/did not reach state "visible"/);
  });

  it('respects nthIndex for detached state with .last()', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([
        makeElementInfo({ elementId: 'a' }),
        makeElementInfo({ elementId: 'b' }),
      ])),
    });
    // .last() targets index -1 which exists — so 'detached' should fail
    const handle = new ElementHandle(client, _text('Hello'), 500).last();
    await expect(handle.waitFor({ state: 'detached', timeout: 500 }))
      .rejects.toThrow(/did not reach state "detached"/);
  });
});

// ─── isEditable ───

describe('isEditable', () => {
  it('returns true for enabled textfield', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([makeElementInfo({ role: 'textfield', enabled: true })])),
    });
    const handle = new ElementHandle(client, _text('Email'), 5000);
    expect(await handle.isEditable()).toBe(true);
  });

  it('returns false for disabled textfield', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([makeElementInfo({ role: 'textfield', enabled: false })])),
    });
    const handle = new ElementHandle(client, _text('Email'), 5000);
    expect(await handle.isEditable()).toBe(false);
  });

  it('returns false for non-textfield element', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([makeElementInfo({ role: 'button', enabled: true })])),
    });
    const handle = new ElementHandle(client, _text('Submit'), 5000);
    expect(await handle.isEditable()).toBe(false);
  });
});

// ─── Same-target duplicate collapsing (PILOT-226) ───
// The iOS accessibility tree exposes some text elements twice: a parent
// StaticText carrying the attributes (testID, traits) and an inner child
// with identical label and pixel-identical bounds. That must not count as
// a strict-mode ambiguity.

describe('same-target duplicate collapsing', () => {
  const parent = makeElementInfo({
    elementId: 'p',
    text: '0',
    resourceId: 'counter-value',
    bounds: { left: 16, top: 674, right: 386, bottom: 751 },
  });
  const childDup = makeElementInfo({
    elementId: 'c',
    text: '0',
    resourceId: '',
    bounds: { left: 16, top: 674, right: 386, bottom: 751 },
  });

  it('tap() does not throw strict violation for an identical parent/child pair', async () => {
    const tap = vi.fn(async () => successResponse());
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([parent, childDup])),
      tap,
    });
    const handle = new ElementHandle(client, _text('0'), 5000);
    await handle.tap();
    expect(tap).toHaveBeenCalled();
  });

  it('find() resolves to the attribute-carrying first occurrence', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([parent, childDup])),
    });
    const handle = new ElementHandle(client, _text('0'), 5000);
    const el = await handle.find();
    expect(el.resourceId).toBe('counter-value');
  });

  it('count() reports collapsed visual elements', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([parent, childDup])),
    });
    const handle = new ElementHandle(client, _text('0'), 5000);
    expect(await handle.count()).toBe(1);
  });

  it('still throws for distinct elements with the same text at different bounds', async () => {
    const other = makeElementInfo({
      elementId: 'q',
      text: '0',
      bounds: { left: 16, top: 100, right: 386, bottom: 150 },
    });
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([other, parent, childDup])),
    });
    const handle = new ElementHandle(client, _text('0'), 5000);
    await expect(handle.tap()).rejects.toThrow(/^strict mode violation/);
  });

  it('does not collapse zero-area elements', async () => {
    const hiddenA = makeElementInfo({ elementId: 'a', text: 'x', bounds: { left: 0, top: 0, right: 0, bottom: 0 } });
    const hiddenB = makeElementInfo({ elementId: 'b', text: 'x', bounds: { left: 0, top: 0, right: 0, bottom: 0 } });
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([hiddenA, hiddenB])),
    });
    const handle = new ElementHandle(client, _text('x'), 5000);
    expect(await handle.count()).toBe(2);
  });
});

describe('strict violation suggestion escaping', () => {
  it('escapes quotes/backslashes/newlines in suggested selectors', async () => {
    const elements = [
      makeElementInfo({ text: 'Say "hi"\nnow', bounds: { left: 0, top: 0, right: 10, bottom: 10 } }),
      makeElementInfo({ text: 'Say "hi" later', bounds: { left: 0, top: 20, right: 10, bottom: 30 } }),
    ];
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(elements)),
    });
    const handle = new ElementHandle(client, _textContains('Say'), 5000);
    const err = await handle.tap().then(
      () => { throw new Error('expected tap to reject'); },
      (e: unknown) => e,
    );
    expect((err as Error).message).toContain('device.getByText("Say \\"hi\\"\\nnow", { exact: true })');
    expect((err as Error).message).toContain('device.getByText("Say \\"hi\\" later", { exact: true })');
  });
});

describe('review follow-ups (PR #124)', () => {
  it('type() on a positional handle auto-waits for the element to appear', async () => {
    let calls = 0;
    const findElements = vi.fn(async () => {
      calls++;
      return makeFindElementsResponse(calls >= 3 ? [makeElementInfo({ text: 'Email', resourceId: 'email' })] : []);
    });
    const typeText = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElements, typeText });
    const handle = new ElementHandle(client, _textContains('Email'), 5000);
    await handle.first().type('hi');
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(typeText).toHaveBeenCalled();
  });

  it('type() throws "not found" after the timeout when the element never appears', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([])),
    });
    const handle = new ElementHandle(client, _text('Ghost'), 400);
    await expect(handle.type('x')).rejects.toThrow(/was not found after waiting/);
  });

  it('actions surface a daemon errorMessage instead of reporting "not found"', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => ({ requestId: '1', elements: [], errorMessage: 'UiAutomation not connected' })),
    });
    const handle = new ElementHandle(client, _text('X'), 5000);
    await expect(handle.tap()).rejects.toThrow(/findElements failed: UiAutomation not connected/);
  });

  it('count() surfaces a daemon errorMessage instead of returning 0', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => ({ requestId: '1', elements: [], errorMessage: 'agent socket closed' })),
    });
    const handle = new ElementHandle(client, _text('X'), 5000);
    await expect(handle.count()).rejects.toThrow(/findElements failed: agent socket closed/);
  });
});

describe('transient stale snapshot handling (wait-for flake regression)', () => {
  // The Android agent stamps this onto a transient UIAutomator
  // StaleObjectException when the hierarchy changes mid-snapshot (e.g. a
  // React re-render right after a tap). PILOT-226's strict pre-action resolve
  // used to report it as a hard "findElements failed", failing the action
  // even with timeout budget left — the cause of the flaky wait-for tests.
  const STALE_MSG = 'Element is stale (UI changed): null';

  it('tap() retries through a transient stale snapshot and then succeeds', async () => {
    let calls = 0;
    const findElements = vi.fn(async () => {
      calls++;
      // First snapshot is stale (UI still re-rendering), the next settles.
      return calls < 2
        ? { requestId: '1', elements: [], errorMessage: STALE_MSG }
        : makeFindElementsResponse([makeElementInfo({ text: 'Show banner' })]);
    });
    const tap = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElements, tap });
    const handle = new ElementHandle(client, _text('Show banner'), 5000);

    await handle.tap();

    expect(calls).toBeGreaterThanOrEqual(2);
    expect(tap).toHaveBeenCalledTimes(1);
  });

  it('a stale snapshot that never settles times out as "not found", not a hard failure', async () => {
    const findElements = vi.fn(async () => ({ requestId: '1', elements: [], errorMessage: STALE_MSG }));
    const tap = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElements, tap });
    const handle = new ElementHandle(client, _text('Show banner'), 400);

    await expect(handle.tap()).rejects.toThrow(/was not found after waiting/);
    // Polled across multiple ticks rather than failing fast on the first stale.
    expect(findElements.mock.calls.length).toBeGreaterThan(1);
    expect(tap).not.toHaveBeenCalled();
  });

  it('a non-stale daemon error still fails fast (boundary — only stale is retryable)', async () => {
    const findElements = vi.fn(async () => ({ requestId: '1', elements: [], errorMessage: 'UiAutomation not connected' }));
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, _text('X'), 5000);

    await expect(handle.tap()).rejects.toThrow(/findElements failed: UiAutomation not connected/);
    expect(findElements).toHaveBeenCalledTimes(1);
  });

  it('waitFor() retries through a transient stale snapshot and then resolves', async () => {
    let calls = 0;
    const findElements = vi.fn(async () => {
      calls++;
      return calls < 2
        ? { requestId: '1', elements: [], errorMessage: STALE_MSG }
        : makeFindElementsResponse([makeElementInfo({ visible: true })]);
    });
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, _text('Banner'), 5000);

    await handle.waitFor({ state: 'visible' });

    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('waitFor() fails fast on a non-stale daemon error instead of timing out', async () => {
    const findElements = vi.fn(async () => ({ requestId: '1', elements: [], errorMessage: 'UiAutomation not connected' }));
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, _text('X'), 5000);

    await expect(handle.waitFor({ state: 'visible' })).rejects.toThrow(/findElements failed: UiAutomation not connected/);
    expect(findElements).toHaveBeenCalledTimes(1);
  });

  it('filter({ has }) surfaces a daemon error from child resolution instead of mis-filtering', async () => {
    // Parent resolves fine; the has-probe (child) resolution hits a daemon
    // error. Without surfacing it, childElements=[] would silently filter out
    // every parent and count() would return 0 instead of failing.
    const findElements = vi.fn(async (selector: Selector) => {
      const proto = selectorToProto(selector);
      if (proto.parent) return { requestId: '1', elements: [], errorMessage: 'UiAutomation not connected' };
      return makeFindElementsResponse([
        makeElementInfo({ elementId: 'p1', bounds: { left: 0, top: 0, right: 100, bottom: 100 } }),
      ]);
    });
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, _role('listitem'), 5000);
    const badge = new ElementHandle(client, _text('Badge'), 5000);

    await expect(handle.filter({ has: badge }).count()).rejects.toThrow(/findElements failed: UiAutomation not connected/);
  });

  it('waitFor({ state: "detached" }) does not resolve on a transient stale snapshot — retries first', async () => {
    // A stale tick is unreliable, not a confirmed absence: it must NOT
    // immediately satisfy 'detached' (which reads an empty result as the
    // target state). Without retrying, the first stale blip would resolve
    // prematurely on tick 1.
    let calls = 0;
    const findElements = vi.fn(async () => {
      calls++;
      return calls < 2
        ? { requestId: '1', elements: [], errorMessage: STALE_MSG }
        : makeFindElementsResponse([]); // genuinely gone on the settled tick
    });
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, _text('Banner'), 5000);

    await handle.waitFor({ state: 'detached' });

    expect(calls).toBeGreaterThanOrEqual(2);
  });
});

describe('scoped selector descriptions (review follow-up)', () => {
  it('renders chained getBy* syntax, not .locator(getBy*())', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([])),
    });
    const parent = new ElementHandle(client, _role('list'), 300);
    const child = parent.getByText('Row', { exact: true });
    await expect(child.find()).rejects.toThrow(
      'getByRole("list").getByText("Row", { exact: true })',
    );
  });
});

describe('scrollIntoView error propagation (review follow-up)', () => {
  it('surfaces a daemon errorMessage instead of swiping to the max', async () => {
    const findElements = vi.fn(async () => ({ requestId: '1', elements: [], errorMessage: 'agent gone' }));
    const swipe = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElements, swipe });
    const handle = new ElementHandle(client, _text('Target'), 5000);
    await expect(handle.scrollIntoView()).rejects.toThrow(/findElements failed: agent gone/);
    expect(swipe).not.toHaveBeenCalled();
  });
});

// ─── Action trace lifecycle (PILOT-244) ───

describe('action trace lifecycle (PILOT-244)', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  interface TraceHarness {
    collector: TraceCollector;
    traceCapture: TraceCapture;
    lifecycle: { event: AnyTraceEvent; lifecycle?: 'started' | 'completed' }[];
  }

  function makeTraceHarness(): TraceHarness {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-eh-trace-'));
    tempDirs.push(tempDir);
    const collector = new TraceCollector({
      mode: 'on', screenshots: false, snapshots: false, sources: false,
      attachments: true, network: false, deviceLogs: false, daemonLogs: false,
    }, tempDir);
    const lifecycle: TraceHarness['lifecycle'] = [];
    collector.setEventCallback((event, _screenshots, life) => {
      lifecycle.push({ event, lifecycle: life });
    });
    const traceCapture: TraceCapture = {
      collector,
      takeScreenshot: async () => undefined,
      captureHierarchy: async () => undefined,
    };
    return { collector, traceCapture, lifecycle };
  }

  const actionEvents = (h: TraceHarness): ActionTraceEvent[] =>
    h.collector.events.filter((e): e is ActionTraceEvent => e.type === 'action');

  it('emits a started lifecycle event before the auto-wait resolves (live in-flight)', async () => {
    const h = makeTraceHarness();
    // findElements stays pending until released, so the action is mid auto-wait.
    let releaseFind!: (v: FindElementsResponse) => void;
    const findElements = vi.fn(
      () => new Promise<FindElementsResponse>((res) => { releaseFind = res; }),
    );
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, _text('Later'), 5000, { traceCapture: h.traceCapture });

    const tapPromise = handle.tap();
    await Promise.resolve(); // let the up-front _emitActionStarted flush

    const started = h.lifecycle.filter((e) => e.lifecycle === 'started');
    expect(started).toHaveLength(1);
    expect((started[0].event as ActionTraceEvent).category).toBe('tap');
    // Still in-flight: no completed event while the auto-wait is pending.
    expect(h.lifecycle.some((e) => e.lifecycle === 'completed')).toBe(false);

    releaseFind(makeFindElementsResponse([makeElementInfo()]));
    await tapPromise;
    expect(actionEvents(h).map((e) => e.action)).toEqual(['tap']);
  });

  it('records a failed action event when element resolution times out', async () => {
    const h = makeTraceHarness();
    const findElements = vi.fn(async () => makeFindElementsResponse([])); // never found
    const tap = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElements, tap });
    const handle = new ElementHandle(client, _text('Missing'), 300, { traceCapture: h.traceCapture });

    await expect(handle.tap()).rejects.toThrow(/was not found after waiting/);
    expect(tap).not.toHaveBeenCalled();

    const events = actionEvents(h);
    expect(events).toHaveLength(1);
    expect(events[0].category).toBe('tap');
    expect(events[0].success).toBe(false);
    expect(events[0].error).toMatch(/was not found after waiting/);
    // The matching started fired too, so the live in-flight slot is cleared.
    expect(h.lifecycle.filter((e) => e.lifecycle === 'started')).toHaveLength(1);
    expect(h.lifecycle.filter((e) => e.lifecycle === 'completed')).toHaveLength(1);
  });

  it('attributes trailing time to the failed action, not the previous (beforeAll) action', async () => {
    const h = makeTraceHarness();
    // Simulate a prior completed action — e.g. a beforeAll route() registration.
    h.collector.addActionEvent({
      category: 'other', action: 'route',
      duration: 5, success: true,
      hasScreenshotBefore: false, hasScreenshotAfter: false,
      hasHierarchyBefore: false, hasHierarchyAfter: false,
    });
    const routeEvent = actionEvents(h).find((e) => e.action === 'route')!;
    const routeWallBefore = routeEvent.wallDuration;

    const findElements = vi.fn(async () => makeFindElementsResponse([]));
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, _text('Missing'), 200, { traceCapture: h.traceCapture });
    await expect(handle.tap()).rejects.toThrow(/was not found after waiting/);

    // Test ends ~30s after the failed tap — this is what finalizeTimeline allocates.
    h.collector.finalizeTimeline(Date.now() + 30_000);

    const tapEvent = actionEvents(h).find((e) => e.action === 'tap')!;
    expect(tapEvent.trailingTime ?? 0).toBeGreaterThan(0);
    // The beforeAll route must NOT have absorbed the trailing time.
    expect(routeEvent.trailingTime ?? 0).toBe(0);
    expect(routeEvent.wallDuration).toBe(routeWallBefore);
  });

  it('traces previously-untraced actions (focus) with started + completed on success', async () => {
    const h = makeTraceHarness();
    const focus = vi.fn(async () => successResponse());
    const client = makeMockClient({ focus });
    const handle = new ElementHandle(client, _text('Field'), 5000, { traceCapture: h.traceCapture });

    await handle.focus();

    const events = actionEvents(h);
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('focus');
    expect(events[0].success).toBe(true);
    expect(h.lifecycle.filter((e) => e.lifecycle === 'started').length).toBeGreaterThanOrEqual(1);
  });

  it('dragTo attributes a target-not-found to the dragTo action', async () => {
    const h = makeTraceHarness();
    const findElements = vi.fn(async (sel: Selector) => {
      const value = (sel.kind as { value?: string }).value;
      return makeFindElementsResponse(value === 'Target' ? [] : [makeElementInfo()]);
    });
    const client = makeMockClient({ findElements });
    const source = new ElementHandle(client, _text('Source'), 300, { traceCapture: h.traceCapture });
    const target = new ElementHandle(client, _text('Target'), 300, { traceCapture: h.traceCapture });

    await expect(source.dragTo(target)).rejects.toThrow(/was not found after waiting/);

    const events = actionEvents(h);
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('dragTo');
    expect(events[0].success).toBe(false);
  });

  it('setChecked: already-in-desired-state emits one success event without tapping', async () => {
    const h = makeTraceHarness();
    const tap = vi.fn(async () => successResponse());
    const el = makeElementInfo({ checked: true, text: 'Switch' });
    const client = makeMockClient({
      findElement: vi.fn(async () => ({ requestId: '1', found: true, element: el, errorMessage: '' })),
      findElements: vi.fn(async () => makeFindElementsResponse([el])),
      tap,
    });
    const handle = new ElementHandle(client, _text('Switch'), 5000, { traceCapture: h.traceCapture });

    await handle.setChecked(true);

    expect(tap).not.toHaveBeenCalled();
    const events = actionEvents(h).filter((e) => e.action === 'setChecked');
    expect(events).toHaveLength(1);
    expect(events[0].success).toBe(true);
  });

  it('setChecked: state never changes → single failed event after tapping', async () => {
    const h = makeTraceHarness();
    const tap = vi.fn(async () => successResponse());
    const el = makeElementInfo({ checked: false, text: 'Switch' });
    const client = makeMockClient({
      findElement: vi.fn(async () => ({ requestId: '1', found: true, element: el, errorMessage: '' })),
      findElements: vi.fn(async () => makeFindElementsResponse([el])),
      tap,
    });
    const handle = new ElementHandle(client, _text('Switch'), 600, { traceCapture: h.traceCapture });

    await expect(handle.setChecked(true)).rejects.toThrow(/did not change after tap/);

    expect(tap).toHaveBeenCalledTimes(1);
    const events = actionEvents(h).filter((e) => e.action === 'setChecked');
    expect(events).toHaveLength(1);
    expect(events[0].success).toBe(false);
  }, 10000);

  it('still records the failed action when the before-capture throws', async () => {
    const h = makeTraceHarness();
    // Simulate an unresponsive device: the failure-path capture rejects. The
    // failed action must still be recorded (the capture is guarded separately).
    vi.spyOn(h.collector, 'captureBeforeAction').mockRejectedValue(new Error('capture boom'));
    const findElements = vi.fn(async () => makeFindElementsResponse([]));
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, _text('Missing'), 200, { traceCapture: h.traceCapture });

    await expect(handle.tap()).rejects.toThrow(/was not found after waiting/);

    const events = actionEvents(h);
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('tap');
    expect(events[0].success).toBe(false);
    expect(events[0].hasScreenshotBefore).toBe(false);
  });

  it('adds no trace overhead and still throws when no trace capture is attached', async () => {
    const findElements = vi.fn(async () => makeFindElementsResponse([]));
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, _text('Missing'), 200); // no traceCapture
    await expect(handle.tap()).rejects.toThrow(/was not found after waiting/);
  });
});
