import { describe, it, expect, vi } from 'vitest';
import { ElementHandle } from '../element-handle.js';
import { type Selector, text, role, className, selectorToProto } from '../selectors.js';
import type {
  PilotGrpcClient,
  FindElementsResponse,
  ActionResponse,
  ElementInfo,
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
    ...overrides,
  } as unknown as PilotGrpcClient;
}

// ─── Constructor ───

describe('ElementHandle constructor', () => {
  it('stores client, selector, and timeout', () => {
    const client = makeMockClient();
    const sel = text('Test');
    const handle = new ElementHandle(client, sel, 5000);
    expect(handle._client).toBe(client);
    expect(handle._selector).toBe(sel);
    expect(handle._timeoutMs).toBe(5000);
  });
});

// ─── element() scoping ───

describe('element() scoping', () => {
  it('creates a child handle with nested selector', () => {
    const client = makeMockClient();
    const parentSel = role('list');
    const parent = new ElementHandle(client, parentSel, 5000);

    const child = parent.element(text('Item 1'));
    expect(child._selector.kind.type).toBe('text');
    expect(child._selector.parent).toBeDefined();
    expect(child._selector.parent!.kind.type).toBe('role');
  });

  it('scoped selector serializes with parent', () => {
    const client = makeMockClient();
    const parentSel = className('android.widget.ListView');
    const parent = new ElementHandle(client, parentSel, 5000);

    const child = parent.element(text('Row'));
    const proto = selectorToProto(child._selector);
    expect(proto).toEqual({
      text: 'Row',
      parent: { className: 'android.widget.ListView' },
    });
  });

  it('preserves client and timeout in child handle', () => {
    const client = makeMockClient();
    const parent = new ElementHandle(client, role('container'), 7000);
    const child = parent.element(text('inner'));
    expect(child._client).toBe(client);
    expect(child._timeoutMs).toBe(7000);
  });

  it('supports multi-level element scoping', () => {
    const client = makeMockClient();
    const root = new ElementHandle(client, role('page'), 5000);
    const mid = root.element(role('section'));
    const leaf = mid.element(text('Label'));

    expect(leaf._selector.parent).toBeDefined();
    expect(leaf._selector.parent!.parent).toBeDefined();
    expect(leaf._selector.parent!.parent!.kind.type).toBe('role');
  });

  it('throws when called on a modified handle', () => {
    const client = makeMockClient();
    const handle = new ElementHandle(client, role('list'), 5000);
    expect(() => handle.first().element(text('Item'))).toThrow(
      'element() cannot be called on a modified handle',
    );
    expect(() => handle.filter({ hasText: 'x' }).element(text('Item'))).toThrow(
      'element() cannot be called on a modified handle',
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
    const handle = new ElementHandle(client, text('Found it'), 5000);
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
    const handle = new ElementHandle(client, text('Missing'), 5000);
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
    const handle = new ElementHandle(client, text('Gone'), 5000);
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
    const handle = new ElementHandle(client, text('X'), 3000);
    await handle.find();
    expect(findElement).toHaveBeenCalledWith(handle._selector, 3000);
  });
});

// ─── exists() ───

describe('exists()', () => {
  it('returns true when element is found', async () => {
    const client = makeMockClient();
    const handle = new ElementHandle(client, text('Present'), 5000);
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
    const handle = new ElementHandle(client, text('Absent'), 5000);
    const result = await handle.exists();
    expect(result).toBe(false);
  });
});

// ─── Action methods ───

describe('tap()', () => {
  it('delegates to client.tap with selector and timeout', async () => {
    const tap = vi.fn(async () => successResponse());
    const client = makeMockClient({ tap });
    const sel = text('Button');
    const handle = new ElementHandle(client, sel, 4000);
    await handle.tap();
    expect(tap).toHaveBeenCalledWith(sel, 4000);
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      tap: vi.fn(async () => failureResponse('Tap target not found')),
    });
    const handle = new ElementHandle(client, text('Missing'), 5000);
    await expect(handle.tap()).rejects.toThrow('Tap target not found');
  });

  it('throws default message when errorMessage is empty', async () => {
    const client = makeMockClient({
      tap: vi.fn(async () => failureResponse('')),
    });
    const handle = new ElementHandle(client, text('X'), 5000);
    await expect(handle.tap()).rejects.toThrow('Tap failed');
  });
});

describe('longPress()', () => {
  it('delegates to client.longPress', async () => {
    const longPress = vi.fn(async () => successResponse());
    const client = makeMockClient({ longPress });
    const sel = text('Item');
    const handle = new ElementHandle(client, sel, 5000);
    await handle.longPress(1000);
    expect(longPress).toHaveBeenCalledWith(sel, 1000, 5000);
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      longPress: vi.fn(async () => failureResponse('Long press failed')),
    });
    const handle = new ElementHandle(client, text('X'), 5000);
    await expect(handle.longPress()).rejects.toThrow('Long press failed');
  });
});

describe('type()', () => {
  it('delegates to client.typeText', async () => {
    const typeText = vi.fn(async () => successResponse());
    const client = makeMockClient({ typeText });
    const sel = text('Input');
    const handle = new ElementHandle(client, sel, 5000);
    await handle.type('hello');
    expect(typeText).toHaveBeenCalledWith(sel, 'hello', 5000);
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      typeText: vi.fn(async () => failureResponse('Type failed')),
    });
    const handle = new ElementHandle(client, text('X'), 5000);
    await expect(handle.type('abc')).rejects.toThrow('Type failed');
  });
});

describe('clearAndType()', () => {
  it('delegates to client.clearAndType', async () => {
    const clearAndType = vi.fn(async () => successResponse());
    const client = makeMockClient({ clearAndType });
    const sel = text('Field');
    const handle = new ElementHandle(client, sel, 5000);
    await handle.clearAndType('new value');
    expect(clearAndType).toHaveBeenCalledWith(sel, 'new value', 5000);
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      clearAndType: vi.fn(async () => failureResponse()),
    });
    const handle = new ElementHandle(client, text('X'), 5000);
    await expect(handle.clearAndType('x')).rejects.toThrow('Action failed');
  });
});

describe('clear()', () => {
  it('delegates to client.clearText', async () => {
    const clearText = vi.fn(async () => successResponse());
    const client = makeMockClient({ clearText });
    const sel = text('Field');
    const handle = new ElementHandle(client, sel, 5000);
    await handle.clear();
    expect(clearText).toHaveBeenCalledWith(sel, 5000);
  });

  it('throws on failure', async () => {
    const client = makeMockClient({
      clearText: vi.fn(async () => failureResponse('Cannot clear')),
    });
    const handle = new ElementHandle(client, text('X'), 5000);
    await expect(handle.clear()).rejects.toThrow('Cannot clear');
  });
});

describe('scroll()', () => {
  it('delegates to client.scroll', async () => {
    const scroll = vi.fn(async () => successResponse());
    const client = makeMockClient({ scroll });
    const sel = text('List');
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
    const handle = new ElementHandle(client, text('X'), 5000);
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
    const handle = new ElementHandle(client, text('X'), 5000);
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
    const handle = new ElementHandle(client, text('X'), 5000);
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
    const handle = new ElementHandle(client, text('X'), 5000);
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
    const handle = new ElementHandle(client, role('listitem'), 5000);
    expect(await handle.count()).toBe(3);
  });

  it('returns 0 when no elements match', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([])),
    });
    const handle = new ElementHandle(client, role('listitem'), 5000);
    expect(await handle.count()).toBe(0);
  });

  it('passes timeout to findElements', async () => {
    const findElements = vi.fn(async () => makeFindElementsResponse([]));
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, role('listitem'), 7000);
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
    const handle = new ElementHandle(client, role('listitem'), 5000);
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
    const handle = new ElementHandle(client, role('listitem'), 5000);
    const items = await handle.all();
    expect(items).toEqual([]);
  });

  it('returned handles resolve to the correct element via nth index', async () => {
    const findElements = vi.fn(async () => makeFindElementsResponse(threeItems));
    const client = makeMockClient({ findElements });
    const handle = new ElementHandle(client, role('listitem'), 5000);
    const items = await handle.all();

    // Each handle's find() should resolve to the correct element by index
    const second = await items[1].find();
    expect(second.text).toBe('Banana');
  });

  it('handles from all() throw when re-indexed with first/last/nth', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
    });
    const handle = new ElementHandle(client, role('listitem'), 5000);
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
    const handle = new ElementHandle(client, role('listitem'), 5000);
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
    const handle = new ElementHandle(client, role('listitem'), 5000);
    const result = await handle.first().find();
    expect(result.text).toBe('Apple');
  });

  it('exists() returns true when at least one element matches', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
    });
    const handle = new ElementHandle(client, role('listitem'), 5000);
    expect(await handle.first().exists()).toBe(true);
  });

  it('exists() returns false when no elements match', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([])),
    });
    const handle = new ElementHandle(client, role('listitem'), 5000);
    expect(await handle.first().exists()).toBe(false);
  });
});

describe('last()', () => {
  it('find() resolves to the last matching element', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
    });
    const handle = new ElementHandle(client, role('listitem'), 5000);
    const result = await handle.last().find();
    expect(result.text).toBe('Cherry');
  });

  it('throws when no elements match', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse([])),
    });
    const handle = new ElementHandle(client, role('listitem'), 5000);
    await expect(handle.last().find()).rejects.toThrow('nth(-1)');
  });
});

describe('nth()', () => {
  it('find() resolves to the element at the given index', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
    });
    const handle = new ElementHandle(client, role('listitem'), 5000);
    const result = await handle.nth(1).find();
    expect(result.text).toBe('Banana');
  });

  it('supports negative indices (counting from end)', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
    });
    const handle = new ElementHandle(client, role('listitem'), 5000);
    const result = await handle.nth(-2).find();
    expect(result.text).toBe('Banana');
  });

  it('throws when index is out of bounds', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
    });
    const handle = new ElementHandle(client, role('listitem'), 5000);
    await expect(handle.nth(5).find()).rejects.toThrow('nth(5)');
  });

  it('throws when negative index is out of bounds', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
    });
    const handle = new ElementHandle(client, role('listitem'), 5000);
    await expect(handle.nth(-4).find()).rejects.toThrow('nth(-4)');
  });

  it('tap() on nth handle uses resolved element selector', async () => {
    const tap = vi.fn(async () => successResponse());
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
      tap,
    });
    const handle = new ElementHandle(client, role('listitem'), 5000);
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
    const handle = new ElementHandle(client, role('listitem'), 5000);
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
    const handle = new ElementHandle(client, role('listitem'), 5000);
    await handle.nth(0).type('hello');
    const calledSelector = (typeText.mock.calls[0] as unknown[])[0] as Selector;
    expect(selectorToProto(calledSelector)).toEqual({ resourceId: 'item_1' });
  });
});

// ─── filter() (PILOT-16) ───

describe('filter()', () => {
  it('returns a new lazy ElementHandle', () => {
    const client = makeMockClient();
    const handle = new ElementHandle(client, role('listitem'), 5000);
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
      const handle = new ElementHandle(client, role('listitem'), 5000);
      const count = await handle.filter({ hasText: 'an' }).count();
      expect(count).toBe(1); // Only "Banana" contains "an"
    });

    it('filters by RegExp', async () => {
      const client = makeMockClient({
        findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
      });
      const handle = new ElementHandle(client, role('listitem'), 5000);
      const count = await handle.filter({ hasText: /^[AB]/ }).count();
      expect(count).toBe(2); // Apple and Banana
    });

    it('find() returns the first matching element', async () => {
      const client = makeMockClient({
        findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
      });
      const handle = new ElementHandle(client, role('listitem'), 5000);
      const result = await handle.filter({ hasText: 'Cherry' }).find();
      expect(result.text).toBe('Cherry');
    });
  });

  describe('hasNotText', () => {
    it('excludes elements matching the text', async () => {
      const client = makeMockClient({
        findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
      });
      const handle = new ElementHandle(client, role('listitem'), 5000);
      const count = await handle.filter({ hasNotText: 'Apple' }).count();
      expect(count).toBe(2); // Banana and Cherry
    });

    it('excludes elements matching a RegExp', async () => {
      const client = makeMockClient({
        findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
      });
      const handle = new ElementHandle(client, role('listitem'), 5000);
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
        // Child selector is text('Premium').within(role('listitem')), so it has a parent
        if (proto.parent) return makeFindElementsResponse(childElements);
        return makeFindElementsResponse(parentElements);
      });
      const client = makeMockClient({ findElements });
      const handle = new ElementHandle(client, role('listitem'), 5000);
      const count = await handle.filter({ has: text('Premium') }).count();
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
        // Child selector is text('Disabled').within(role('listitem')), so it has a parent
        if (proto.parent) return makeFindElementsResponse(childElements);
        return makeFindElementsResponse(parentElements);
      });
      const client = makeMockClient({ findElements });
      const handle = new ElementHandle(client, role('listitem'), 5000);
      const count = await handle.filter({ hasNot: text('Disabled') }).count();
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
      const handle = new ElementHandle(client, role('listitem'), 5000);
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
    const handle = new ElementHandle(client, role('listitem'), 5000);
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

    const buttons = new ElementHandle(client, role('button'), 5000);
    const submit = new ElementHandle(client, text('Submit'), 5000);
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

    const buttons = new ElementHandle(client, role('button'), 5000);
    const other = new ElementHandle(client, text('Other'), 5000);
    expect(await buttons.and(other).count()).toBe(0);
  });

  it('and() with tap() resolves and taps the matching element', async () => {
    const tap = vi.fn(async () => successResponse());
    const intersectEl = makeElementInfo({ elementId: 'e1', text: 'Submit', resourceId: 'btn-submit' });
    const findElements = vi.fn(async () => makeFindElementsResponse([intersectEl]));
    const client = makeMockClient({ findElements, tap });

    const buttons = new ElementHandle(client, role('button'), 5000);
    const submit = new ElementHandle(client, text('Submit'), 5000);
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

    const ok = new ElementHandle(client, text('OK'), 5000);
    const confirm = new ElementHandle(client, text('Confirm'), 5000);
    expect(await ok.or(confirm).count()).toBe(2);
  });

  it('deduplicates elements present in both selectors', async () => {
    const sharedEl = makeElementInfo({ elementId: 'e1', text: 'Submit' });
    const findElements = vi.fn(async () => makeFindElementsResponse([sharedEl]));
    const client = makeMockClient({ findElements });

    const a = new ElementHandle(client, role('button'), 5000);
    const b = new ElementHandle(client, text('Submit'), 5000);
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

    const ok = new ElementHandle(client, text('OK'), 5000);
    const confirm = new ElementHandle(client, text('Confirm'), 5000);
    await ok.or(confirm).tap();

    const calledSelector = (tap.mock.calls[0] as unknown[])[0] as Selector;
    // OK has no resourceId or contentDescription, so falls back to text selector
    expect(selectorToProto(calledSelector)).toEqual({ text: 'OK' });
  });

  it('or() throws when neither selector matches', async () => {
    const findElements = vi.fn(async () => makeFindElementsResponse([]));
    const client = makeMockClient({ findElements });

    const a = new ElementHandle(client, text('OK'), 5000);
    const b = new ElementHandle(client, text('Confirm'), 5000);
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

    const a = new ElementHandle(client, text('A'), 5000);
    const b = new ElementHandle(client, text('B'), 5000);
    const c = new ElementHandle(client, text('C'), 5000);
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

    const a = new ElementHandle(client, text('A'), 5000);
    const b = new ElementHandle(client, text('B'), 5000);
    const c = new ElementHandle(client, text('C'), 5000);
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
    const handle = new ElementHandle(client, role('listitem'), 5000);
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

    const a = new ElementHandle(client, text('A'), 5000);
    const b = new ElementHandle(client, text('B'), 5000);
    const result = await a.or(b).nth(1).find();
    expect(result.text).toBe('B');
  });

  it('all() handles resolve correctly for iteration with assertions', async () => {
    const client = makeMockClient({
      findElements: vi.fn(async () => makeFindElementsResponse(threeItems)),
    });
    const handle = new ElementHandle(client, role('listitem'), 5000);
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
    const sel = text('Button');
    const handle = new ElementHandle(client, sel, 5000);

    await handle.tap();

    // Should use direct selector, not resolve via findElements
    expect(findElements).not.toHaveBeenCalled();
    expect(tap).toHaveBeenCalledWith(sel, 5000);
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
    const handle = new ElementHandle(client, role('button'), 5000);
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

    const a = new ElementHandle(client, text('A'), 5000);
    const b = new ElementHandle(client, text('B'), 5000);

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
    const handle = new ElementHandle(client, role('button'), 5000);
    await expect(handle.first().tap()).rejects.toThrow('Cannot target element for action');
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

    const a = new ElementHandle(client, text('A'), 5000);
    const b = new ElementHandle(client, text('B'), 5000);

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
