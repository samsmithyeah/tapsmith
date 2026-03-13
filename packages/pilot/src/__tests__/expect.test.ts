import { describe, it, expect as vitestExpect, vi } from 'vitest';
import { expect as pilotExpect } from '../expect.js';
import { ElementHandle } from '../element-handle.js';
import { text, role } from '../selectors.js';
import type { PilotGrpcClient, FindElementResponse, ElementInfo } from '../grpc-client.js';

// ─── Mock helpers ───

function makeElementInfo(overrides: Partial<ElementInfo> = {}): ElementInfo {
  return {
    elementId: 'el-1',
    className: 'android.widget.TextView',
    text: '',
    contentDescription: '',
    resourceId: '',
    enabled: true,
    visible: true,
    clickable: false,
    focusable: false,
    scrollable: false,
    hint: '',
    checked: false,
    selected: false,
    ...overrides,
  };
}

function makeMockClient(findElementImpl: () => Promise<FindElementResponse>): PilotGrpcClient {
  return {
    findElement: vi.fn(findElementImpl),
  } as unknown as PilotGrpcClient;
}

function makeHandle(
  client: PilotGrpcClient,
  selector = text('Hello'),
  timeoutMs = 100,
): ElementHandle {
  return new ElementHandle(client, selector, timeoutMs);
}

// ─── toBeVisible() ───

describe('toBeVisible()', () => {
  it('passes when element is visible', async () => {
    const client = makeMockClient(async () => ({
      requestId: '1',
      found: true,
      element: makeElementInfo({ visible: true }),
      errorMessage: '',
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).toBeVisible({ timeout: 50 });
  });

  it('fails when element is not visible', async () => {
    const client = makeMockClient(async () => ({
      requestId: '1',
      found: true,
      element: makeElementInfo({ visible: false }),
      errorMessage: '',
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).toBeVisible({ timeout: 50 }),
    ).rejects.toThrow('to be visible');
  });

  it('fails when element is not found', async () => {
    const client = makeMockClient(async () => ({
      requestId: '1',
      found: false,
      errorMessage: 'not found',
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).toBeVisible({ timeout: 50 }),
    ).rejects.toThrow('to be visible');
  });

  it('not.toBeVisible() passes when element is not visible', async () => {
    const client = makeMockClient(async () => ({
      requestId: '1',
      found: true,
      element: makeElementInfo({ visible: false }),
      errorMessage: '',
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).not.toBeVisible({ timeout: 50 });
  });

  it('not.toBeVisible() fails when element is visible', async () => {
    const client = makeMockClient(async () => ({
      requestId: '1',
      found: true,
      element: makeElementInfo({ visible: true }),
      errorMessage: '',
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).not.toBeVisible({ timeout: 50 }),
    ).rejects.toThrow('NOT to be visible');
  });
});

// ─── toBeEnabled() ───

describe('toBeEnabled()', () => {
  it('passes when element is enabled', async () => {
    const client = makeMockClient(async () => ({
      requestId: '1',
      found: true,
      element: makeElementInfo({ enabled: true }),
      errorMessage: '',
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).toBeEnabled({ timeout: 50 });
  });

  it('fails when element is disabled', async () => {
    const client = makeMockClient(async () => ({
      requestId: '1',
      found: true,
      element: makeElementInfo({ enabled: false }),
      errorMessage: '',
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).toBeEnabled({ timeout: 50 }),
    ).rejects.toThrow('to be enabled');
  });

  it('not.toBeEnabled() passes when element is disabled', async () => {
    const client = makeMockClient(async () => ({
      requestId: '1',
      found: true,
      element: makeElementInfo({ enabled: false }),
      errorMessage: '',
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).not.toBeEnabled({ timeout: 50 });
  });

  it('not.toBeEnabled() fails when element is enabled', async () => {
    const client = makeMockClient(async () => ({
      requestId: '1',
      found: true,
      element: makeElementInfo({ enabled: true }),
      errorMessage: '',
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).not.toBeEnabled({ timeout: 50 }),
    ).rejects.toThrow('NOT to be enabled');
  });
});

// ─── toHaveText() ───

describe('toHaveText()', () => {
  it('passes when text matches', async () => {
    const client = makeMockClient(async () => ({
      requestId: '1',
      found: true,
      element: makeElementInfo({ text: 'Hello World' }),
      errorMessage: '',
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).toHaveText('Hello World', { timeout: 50 });
  });

  it('fails when text does not match', async () => {
    const client = makeMockClient(async () => ({
      requestId: '1',
      found: true,
      element: makeElementInfo({ text: 'Wrong text' }),
      errorMessage: '',
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).toHaveText('Expected text', { timeout: 50 }),
    ).rejects.toThrow('to have text "Expected text"');
  });

  it('includes actual text in error message', async () => {
    const client = makeMockClient(async () => ({
      requestId: '1',
      found: true,
      element: makeElementInfo({ text: 'actual' }),
      errorMessage: '',
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).toHaveText('expected', { timeout: 50 }),
    ).rejects.toThrow('got "actual"');
  });

  it('not.toHaveText() passes when text differs', async () => {
    const client = makeMockClient(async () => ({
      requestId: '1',
      found: true,
      element: makeElementInfo({ text: 'different' }),
      errorMessage: '',
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).not.toHaveText('expected', { timeout: 50 });
  });

  it('not.toHaveText() fails when text matches', async () => {
    const client = makeMockClient(async () => ({
      requestId: '1',
      found: true,
      element: makeElementInfo({ text: 'same' }),
      errorMessage: '',
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).not.toHaveText('same', { timeout: 50 }),
    ).rejects.toThrow('NOT to have text');
  });
});

// ─── toExist() ───

describe('toExist()', () => {
  it('passes when element exists', async () => {
    const client = makeMockClient(async () => ({
      requestId: '1',
      found: true,
      element: makeElementInfo(),
      errorMessage: '',
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).toExist({ timeout: 50 });
  });

  it('fails when element does not exist', async () => {
    const client = makeMockClient(async () => ({
      requestId: '1',
      found: false,
      errorMessage: '',
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).toExist({ timeout: 50 }),
    ).rejects.toThrow('to exist');
  });

  it('not.toExist() passes when element is absent', async () => {
    const client = makeMockClient(async () => ({
      requestId: '1',
      found: false,
      errorMessage: '',
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).not.toExist({ timeout: 50 });
  });

  it('not.toExist() fails when element exists', async () => {
    const client = makeMockClient(async () => ({
      requestId: '1',
      found: true,
      element: makeElementInfo(),
      errorMessage: '',
    }));
    const handle = makeHandle(client);
    await vitestExpect(
      pilotExpect(handle).not.toExist({ timeout: 50 }),
    ).rejects.toThrow('NOT to exist');
  });
});

// ─── Timeout and polling ───

describe('polling behavior', () => {
  it('retries until element becomes visible within timeout', async () => {
    let callCount = 0;
    const client = makeMockClient(async () => {
      callCount++;
      return {
        requestId: '1',
        found: true,
        element: makeElementInfo({ visible: callCount >= 3 }),
        errorMessage: '',
      };
    });
    const handle = makeHandle(client, text('delayed'), 2000);
    await pilotExpect(handle).toBeVisible({ timeout: 2000 });
    vitestExpect(callCount).toBeGreaterThanOrEqual(3);
  });

  it('handles client errors gracefully during polling', async () => {
    let callCount = 0;
    const client = makeMockClient(async () => {
      callCount++;
      if (callCount < 3) throw new Error('connection error');
      return {
        requestId: '1',
        found: true,
        element: makeElementInfo({ visible: true }),
        errorMessage: '',
      };
    });
    const handle = makeHandle(client, text('retry'), 2000);
    await pilotExpect(handle).toBeVisible({ timeout: 2000 });
    vitestExpect(callCount).toBeGreaterThanOrEqual(3);
  });

  it('uses handle timeout when no explicit timeout given', async () => {
    const client = makeMockClient(async () => ({
      requestId: '1',
      found: true,
      element: makeElementInfo({ visible: true }),
      errorMessage: '',
    }));
    const handle = makeHandle(client, text('test'), 500);
    // Should not throw - uses the 500ms handle timeout
    await pilotExpect(handle).toBeVisible();
  });
});

// ─── Double negation ───

describe('double negation', () => {
  it('not.not behaves like positive assertion', async () => {
    const client = makeMockClient(async () => ({
      requestId: '1',
      found: true,
      element: makeElementInfo({ visible: true }),
      errorMessage: '',
    }));
    const handle = makeHandle(client);
    await pilotExpect(handle).not.not.toBeVisible({ timeout: 50 });
  });
});
