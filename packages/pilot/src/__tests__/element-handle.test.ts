import { describe, it, expect, vi } from 'vitest';
import { ElementHandle } from '../element-handle.js';
import { type Selector, _text, _role, _className, _id, selectorToProto } from '../selectors.js';
import type {
  PilotGrpcClient,
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

function makeMockClient(overrides: Partial<PilotGrpcClient> = {}): PilotGrpcClient {
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
  } as unknown as PilotGrpcClient;
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

  it('throws when called on a modified handle', () => {
    const client = makeMockClient();
    const handle = new ElementHandle(client, _role('list'), 5000);
    expect(() => handle.first().getByText('Item')).toThrow(
      /getBy.*cannot be called on a modified handle/,
    );
    expect(() => handle.filter({ hasText: 'x' }).getByText('Item')).toThrow(
      /getBy.*cannot be called on a modified handle/,
    );
  });
});

// ─── find() ───

describe('find()', () => {
  it('returns ElementInfo when found', async () => {
    const info = makeElementInfo({ text: 'Found it' });
    const client = makeMockClient({
      findElement: vi.fn(async () => ({
        requestId: '1',
        found: true,
        element: info,
        errorMessage: '',
      })),
    });
    const handle = new ElementHandle(client, _text('Found it'), 5000);
    const result = await handle.find();
    expect(result.text).toBe('Found it');
  });

  it('throws when element is not found', async () => {
    const client = makeMockClient({
      findElement: vi.fn(async () => ({
        requestId: '1',
        found: false,
        errorMessage: 'Element not found',
      })),
    });
    const handle = new ElementHandle(client, _text('Missing'), 5000);
    await expect(handle.find()).rejects.toThrow('Element not found');
  });

  it('throws with selector description when no error message', async () => {
    const client = makeMockClient({
      findElement: vi.fn(async () => ({
        requestId: '1',
        found: false,
        errorMessage: '',
      })),
    });
    const handle = new ElementHandle(client, _text('Gone'), 5000);
    await expect(handle.find()).rejects.toThrow('Element not found');
  });

  it('passes timeout to client', async () => {
    const findElement = vi.fn(async () => ({
      requestId: '1',
      found: true,
      element: makeElementInfo(),
      errorMessage: '',
    }));
    const client = makeMockClient({ findElement });
    const handle = new ElementHandle(client, _text('X'), 3000);
    await handle.find();
    expect(findElement).toHaveBeenCalledWith(handle._selector, 3000);
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
    // findElement is called once by _waitForEnabled to check enabled state
    expect(client.findElement).toHaveBeenCalled();
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
    const findElement = vi.fn(async () => {
      callCount++;
      return {
        requestId: '1',
        found: true,
        element: makeElementInfo({ enabled: callCount >= 3 }),
        errorMessage: '',
      };
    });
    const tap = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElement, tap });
    const handle = new ElementHandle(client, _text('Submit'), 5000);
    await handle.tap();
    expect(callCount).toBeGreaterThanOrEqual(3);
    expect(tap).toHaveBeenCalled();
  });

  it('throws "disabled" when element is found but stays disabled', async () => {
    const findElement = vi.fn(async () => ({
      requestId: '1',
      found: true,
      element: makeElementInfo({ enabled: false }),
      errorMessage: '',
    }));
    const client = makeMockClient({ findElement });
    const handle = new ElementHandle(client, _text('Submit'), 500);
    await expect(handle.tap()).rejects.toThrow(/is disabled/);
  });

  it('throws "not found" when element never appears', async () => {
    const findElement = vi.fn(async () => ({
      requestId: '1',
      found: false,
      element: undefined as unknown as ElementInfo,
      errorMessage: 'not found',
    }));
    const client = makeMockClient({ findElement });
    const handle = new ElementHandle(client, _text('Ghost'), 500);
    await expect(handle.tap()).rejects.toThrow(/was not found/);
  });

  it('with timeout 0 skips the enabled wait and still invokes tap', async () => {
    const findElement = vi.fn(async () => ({
      requestId: '1',
      found: true,
      element: makeElementInfo({ enabled: true }),
      errorMessage: '',
    }));
    const tap = vi.fn(async () => successResponse());
    const client = makeMockClient({ findElement, tap });
    const handle = new ElementHandle(client, _text('Now'), 0);
    await handle.tap();
    expect(findElement).not.toHaveBeenCalled();
    expect(tap).toHaveBeenCalledWith(expect.anything(), 0);
  });

  it('propagates non-"not found" errors from findElement instead of masking them as timeout', async () => {
    // Regression: the old catch-all swallowed gRPC failures and surfaced
    // them as "Element X was not found after waiting Nms", obscuring the
    // real cause (e.g. daemon crashed, network down). Only no-match errors
    // should keep the poll loop alive; everything else must propagate.
    const findElement = vi.fn(async () => {
      throw new Error('14 UNAVAILABLE: No connection established');
    });
    const client = makeMockClient({ findElement });
    const handle = new ElementHandle(client, _text('Anything'), 5000);
    await expect(handle.tap()).rejects.toThrow(/UNAVAILABLE/);
  });

  it('floors the action budget when the element becomes enabled near the deadline', async () => {
    // Use fake timers so the test doesn't burn ~2s of real wall time. The
    // mock's setTimeout and _waitForEnabled's Date.now()/setTimeout both run
    // against the faked clock.
    vi.useFakeTimers();
    try {
      const findElement = vi.fn(async () => {
        // Burn almost the whole 2000ms budget before reporting enabled.
        await new Promise((r) => setTimeout(r, 1900));
        return {
          requestId: '1',
          found: true,
          element: makeElementInfo({ enabled: true }),
          errorMessage: '',
        };
      });
      const tap = vi.fn(async () => successResponse());
      const client = makeMockClient({ findElement, tap });
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
    expect(typeText).toHaveBeenCalledWith(sel, 'hello', 5000);
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
    expect(clearAndType).toHaveBeenCalledWith(sel, 'new value', 5000);
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
    expect(clearText).toHaveBeenCalledWith(sel, 5000);
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
    expect(scroll).toHaveBeenCalledWith(sel, 'down', {
      distance: 500,
      timeoutMs: 5000,
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
      findElement: vi.fn(async () => ({
        requestId: '1',
        found: true,
        element: makeElementInfo({ text: 'Content here' }),
        errorMessage: '',
      })),
    });
    const handle = new ElementHandle(client, _text('X'), 5000);
    const result = await handle.getText();
    expect(result).toBe('Content here');
  });
});

describe('isVisible()', () => {
  it('returns visibility from found element', async () => {
    const client = makeMockClient({
      findElement: vi.fn(async () => ({
        requestId: '1',
        found: true,
        element: makeElementInfo({ visible: false }),
        errorMessage: '',
      })),
    });
    const handle = new ElementHandle(client, _text('X'), 5000);
    expect(await handle.isVisible()).toBe(false);
  });
});

describe('isEnabled()', () => {
  it('returns enabled state from found element', async () => {
    const client = makeMockClient({
      findElement: vi.fn(async () => ({
        requestId: '1',
        found: true,
        element: makeElementInfo({ enabled: false }),
        errorMessage: '',
      })),
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

  it('action methods on unmodified handle use direct selector (fast path)', async () => {
    const tap = vi.fn(async () => successResponse());
    const findElements = vi.fn();
    const client = makeMockClient({ tap, findElements });
    const sel = _text('Button');
    const handle = new ElementHandle(client, sel, 5000);

    await handle.tap();

    // Should use direct selector, not resolve via findElements
    expect(findElements).not.toHaveBeenCalled();
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
    expect(doubleTap).toHaveBeenCalledWith(sel, 4000);
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

  it('unmodified handle uses direct selector (fast path)', async () => {
    const doubleTap = vi.fn(async () => successResponse());
    const findElements = vi.fn();
    const client = makeMockClient({ doubleTap, findElements });
    const sel = _text('Button');
    const handle = new ElementHandle(client, sel, 5000);
    await handle.doubleTap();
    expect(findElements).not.toHaveBeenCalled();
    expect(doubleTap).toHaveBeenCalledWith(sel, 5000);
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
    expect(dragAndDrop).toHaveBeenCalledWith(sourceSel, targetSel, 5000);
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
    const client = makeMockClient({
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
    const client = makeMockClient({
      findElements: vi.fn(async () => {
        callCount++;
        // First call: checked, second call (verification): unchecked
        const checked = callCount <= 1;
        return makeFindElementsResponse([makeElementInfo({ checked, text: 'Switch', resourceId: 'sw1' })]);
      }),
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
    const handle = new ElementHandle(client, _text('Switch'), 5000);
    await expect(handle.setChecked(true)).rejects.toThrow('did not change after tap');
  });

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
    expect(selectOption).toHaveBeenCalledWith(sel, 'Option 2', 5000);
  });

  it('delegates to client.selectOption with index option', async () => {
    const selectOption = vi.fn(async () => successResponse());
    const client = makeMockClient({ selectOption });
    const sel = _text('Dropdown');
    const handle = new ElementHandle(client, sel, 5000);
    await handle.selectOption({ index: 1 });
    expect(selectOption).toHaveBeenCalledWith(sel, { index: 1 }, 5000);
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
    expect(takeElementScreenshot).toHaveBeenCalledWith(sel, 5000);
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
      findElement: vi.fn(async () => ({
        requestId: '1',
        found: true,
        element: makeElementInfo({ bounds: { left: 10, top: 20, right: 110, bottom: 70 } }),
        errorMessage: '',
      })),
    });
    const handle = new ElementHandle(client, _text('Header'), 5000);
    const box = await handle.boundingBox();
    expect(box).toEqual({ x: 10, y: 20, width: 100, height: 50 });
  });

  it('returns null when element has no bounds', async () => {
    const client = makeMockClient({
      findElement: vi.fn(async () => ({
        requestId: '1',
        found: true,
        element: makeElementInfo({ bounds: undefined }),
        errorMessage: '',
      })),
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
    expect(pinchZoom).toHaveBeenCalledWith(sel, 0.5, 5000);
  });

  it('accepts custom scale', async () => {
    const pinchZoom = vi.fn(async () => successResponse());
    const client = makeMockClient({ pinchZoom });
    const sel = _text('Map');
    const handle = new ElementHandle(client, sel, 5000);
    await handle.pinchIn({ scale: 0.3 });
    expect(pinchZoom).toHaveBeenCalledWith(sel, 0.3, 5000);
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
    expect(pinchZoom).toHaveBeenCalledWith(sel, 2.0, 5000);
  });

  it('accepts custom scale', async () => {
    const pinchZoom = vi.fn(async () => successResponse());
    const client = makeMockClient({ pinchZoom });
    const sel = _text('Map');
    const handle = new ElementHandle(client, sel, 5000);
    await handle.pinchOut({ scale: 3.0 });
    expect(pinchZoom).toHaveBeenCalledWith(sel, 3.0, 5000);
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
    expect(focus).toHaveBeenCalledWith(sel, 5000);
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

  it('unmodified handle uses direct selector', async () => {
    const focus = vi.fn(async () => successResponse());
    const findElements = vi.fn();
    const client = makeMockClient({ focus, findElements });
    const sel = _text('Input');
    const handle = new ElementHandle(client, sel, 5000);
    await handle.focus();
    expect(findElements).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalledWith(sel, 5000);
  });
});

describe('blur()', () => {
  it('delegates to client.blur with selector and timeout', async () => {
    const blur = vi.fn(async () => successResponse());
    const client = makeMockClient({ blur });
    const sel = _text('Email');
    const handle = new ElementHandle(client, sel, 5000);
    await handle.blur();
    expect(blur).toHaveBeenCalledWith(sel, 5000);
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
      findElement: vi.fn(async () => ({
        requestId: '1',
        found: true,
        element: makeElementInfo({ checked: true }),
        errorMessage: '',
      })),
    });
    const handle = new ElementHandle(client, _text('Switch'), 5000);
    expect(await handle.isChecked()).toBe(true);
  });

  it('returns false when element is not checked', async () => {
    const client = makeMockClient({
      findElement: vi.fn(async () => ({
        requestId: '1',
        found: true,
        element: makeElementInfo({ checked: false }),
        errorMessage: '',
      })),
    });
    const handle = new ElementHandle(client, _text('Switch'), 5000);
    expect(await handle.isChecked()).toBe(false);
  });
});

// ─── inputValue() (PILOT-27) ───

describe('inputValue()', () => {
  it('returns the text value of the element', async () => {
    const client = makeMockClient({
      findElement: vi.fn(async () => ({
        requestId: '1',
        found: true,
        element: makeElementInfo({ text: 'user@example.com' }),
        errorMessage: '',
      })),
    });
    const handle = new ElementHandle(client, _text('Email'), 5000);
    expect(await handle.inputValue()).toBe('user@example.com');
  });

  it('returns empty string when field is empty', async () => {
    const client = makeMockClient({
      findElement: vi.fn(async () => ({
        requestId: '1',
        found: true,
        element: makeElementInfo({ text: '' }),
        errorMessage: '',
      })),
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
    expect(highlight).toHaveBeenCalledWith(sel, undefined, 5000);
  });

  it('passes durationMs option', async () => {
    const highlight = vi.fn(async () => successResponse());
    const client = makeMockClient({ highlight });
    const sel = _text('Submit');
    const handle = new ElementHandle(client, sel, 5000);
    await handle.highlight({ durationMs: 2000 });
    expect(highlight).toHaveBeenCalledWith(sel, 2000, 5000);
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
