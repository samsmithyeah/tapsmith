import { describe, it, expect, vi } from 'vitest';
import { ElementHandle } from '../element-handle.js';
import { text, role, className, selectorToProto } from '../selectors.js';
import type {
  PilotGrpcClient,
  FindElementResponse,
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

function makeMockClient(overrides: Partial<PilotGrpcClient> = {}): PilotGrpcClient {
  return {
    findElement: vi.fn(async () => ({
      requestId: '1',
      found: true,
      element: makeElementInfo(),
      errorMessage: '',
    })),
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
