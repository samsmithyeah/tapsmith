import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emitActionProgress, type ActionProgressEvent } from '../action-progress.js';
import { createActionProgressMessenger, type ActionProgressPhase } from '../action-progress-renderer.js';

describe('createActionProgressMessenger', () => {
  let messages: Array<{ text: string; phase: ActionProgressPhase }>;
  let dispose: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    messages = [];
  });

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    vi.useRealTimers();
  });

  function subscribe(options: { startDelayMs?: number; heartbeatMs?: number } = {}): void {
    dispose = createActionProgressMessenger({
      ...options,
      emit: (text, phase) => messages.push({ text, phase }),
    });
  }

  function start(id: number, action: ActionProgressEvent['action'] = 'saveAppState', target?: string): void {
    emitActionProgress({ kind: 'start', id, action, target });
  }

  function end(id: number, overrides: Partial<ActionProgressEvent> = {}): void {
    emitActionProgress({
      kind: 'end', id, action: 'saveAppState',
      durationMs: 5_000, success: true, ...overrides,
    });
  }

  it('stays silent for actions that finish before the start delay', () => {
    subscribe();
    start(1);
    vi.advanceTimersByTime(2_000);
    end(1, { durationMs: 2_000 });
    vi.advanceTimersByTime(60_000);
    expect(messages).toHaveLength(0);
  });

  it('announces slow actions, heartbeats, and prints a done line', () => {
    subscribe();
    start(1, 'saveAppState', 'com.foo → state.tar.gz');

    vi.advanceTimersByTime(3_000);
    expect(messages).toEqual([
      { text: '⏳ Saving app state (com.foo → state.tar.gz)…', phase: 'start' },
    ]);

    vi.advanceTimersByTime(30_000);
    expect(messages.filter((m) => m.phase === 'heartbeat')).toHaveLength(2);
    expect(messages[1].text).toBe('⏳ Still saving app state (com.foo → state.tar.gz)… (18s)');

    end(1, { durationMs: 33_200, target: 'com.foo → state.tar.gz' });
    expect(messages.at(-1)).toEqual({
      text: '✓ Saved app state (com.foo → state.tar.gz) (33.2s)',
      phase: 'end',
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('prints a failure line with the error message', () => {
    subscribe();
    start(1, 'restoreAppState');
    vi.advanceTimersByTime(4_000);
    emitActionProgress({
      kind: 'end', id: 1, action: 'restoreAppState',
      durationMs: 4_000, success: false, error: 'tar failed',
    });
    expect(messages.at(-1)?.text).toBe('✗ Restore app state failed (4.0s): tar failed');
  });

  it('prints a neutral stopped line for aborted actions', () => {
    subscribe();
    start(1, 'clearAppData', 'com.foo');
    vi.advanceTimersByTime(4_000);
    emitActionProgress({
      kind: 'end', id: 1, action: 'clearAppData', target: 'com.foo',
      durationMs: 4_000, success: false, aborted: true, error: 'Stopped by user',
    });
    expect(messages.at(-1)?.text).toBe('– Stopped clearing app data (com.foo) (4.0s)');
  });

  it('prints a done line for slow actions even if the start timer never fired', () => {
    subscribe();
    // End arrives with a long duration but before the (starved) timer fires.
    end(1, { durationMs: 5_000 });
    expect(messages).toEqual([
      { text: '✓ Saved app state (5.0s)', phase: 'end' },
    ]);
  });

  it('tracks overlapping actions independently', () => {
    subscribe();
    start(1, 'sessionReady', 'com.foo');
    start(2, 'startAgent', 'com.foo');
    vi.advanceTimersByTime(3_000);
    expect(messages.map((m) => m.text)).toEqual([
      '⏳ Waiting for app to be ready (com.foo)…',
      '⏳ Starting automation agent (com.foo)…',
    ]);
    emitActionProgress({ kind: 'end', id: 2, action: 'startAgent', target: 'com.foo', durationMs: 3_500, success: true });
    emitActionProgress({ kind: 'end', id: 1, action: 'sessionReady', target: 'com.foo', durationMs: 4_000, success: true });
    expect(messages.at(-2)?.text).toBe('✓ Automation agent started (com.foo) (3.5s)');
    expect(messages.at(-1)?.text).toBe('✓ App ready (com.foo) (4.0s)');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears all timers on dispose', () => {
    subscribe();
    start(1);
    start(2);
    vi.advanceTimersByTime(3_000); // both announced, heartbeats armed
    dispose!();
    dispose = undefined;
    expect(vi.getTimerCount()).toBe(0);

    // Unsubscribed: further events are ignored.
    end(1);
    expect(messages.filter((m) => m.phase === 'end')).toHaveLength(0);
  });

  it('disables heartbeats when heartbeatMs is 0', () => {
    subscribe({ heartbeatMs: 0 });
    start(1);
    vi.advanceTimersByTime(120_000);
    expect(messages.filter((m) => m.phase === 'heartbeat')).toHaveLength(0);
    expect(messages.filter((m) => m.phase === 'start')).toHaveLength(1);
  });
});
