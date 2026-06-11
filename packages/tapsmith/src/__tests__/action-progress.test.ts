import { describe, expect, it, vi } from 'vitest';
import { TestAbortedError } from '../abort.js';
import {
  emitActionProgress,
  onActionProgress,
  withActionProgress,
  type ActionProgressEvent,
} from '../action-progress.js';

function collect(): { events: ActionProgressEvent[]; unsubscribe: () => void } {
  const events: ActionProgressEvent[] = [];
  const unsubscribe = onActionProgress((ev) => events.push(ev));
  return { events, unsubscribe };
}

describe('action-progress channel', () => {
  it('delivers events to subscribers and stops after unsubscribe', () => {
    const { events, unsubscribe } = collect();
    emitActionProgress({ kind: 'start', id: 1, action: 'saveAppState' });
    expect(events).toHaveLength(1);

    unsubscribe();
    emitActionProgress({ kind: 'end', id: 1, action: 'saveAppState' });
    expect(events).toHaveLength(1);
  });

  it('isolates listener exceptions from other listeners', () => {
    const bad = vi.fn(() => { throw new Error('boom'); });
    const good = vi.fn();
    const unsub1 = onActionProgress(bad);
    const unsub2 = onActionProgress(good);
    try {
      expect(() => emitActionProgress({ kind: 'start', id: 1, action: 'restartApp' })).not.toThrow();
      expect(good).toHaveBeenCalledTimes(1);
    } finally {
      unsub1();
      unsub2();
    }
  });

  describe('withActionProgress', () => {
    it('emits paired start/end with duration and success on success', async () => {
      const { events, unsubscribe } = collect();
      try {
        const result = await withActionProgress('saveAppState', 'com.foo → state.tar.gz', async () => 42);
        expect(result).toBe(42);
        expect(events).toHaveLength(2);
        expect(events[0]).toMatchObject({ kind: 'start', action: 'saveAppState', target: 'com.foo → state.tar.gz' });
        expect(events[1]).toMatchObject({ kind: 'end', action: 'saveAppState', success: true });
        expect(events[1].aborted).toBeUndefined();
        expect(events[1].id).toBe(events[0].id);
        expect(events[1].durationMs).toBeGreaterThanOrEqual(0);
      } finally {
        unsubscribe();
      }
    });

    it('emits a failed end event and rethrows on error', async () => {
      const { events, unsubscribe } = collect();
      try {
        await expect(
          withActionProgress('restoreAppState', 'com.foo', async () => { throw new Error('tar failed'); }),
        ).rejects.toThrow('tar failed');
        expect(events[1]).toMatchObject({
          kind: 'end', action: 'restoreAppState', success: false, aborted: false, error: 'tar failed',
        });
      } finally {
        unsubscribe();
      }
    });

    it('marks abort errors as aborted', async () => {
      const { events, unsubscribe } = collect();
      try {
        await expect(
          withActionProgress('clearAppData', 'com.foo', async () => { throw new TestAbortedError(); }),
        ).rejects.toThrow();
        expect(events[1]).toMatchObject({ kind: 'end', success: false, aborted: true });
      } finally {
        unsubscribe();
      }
    });

    it('passes through without emitting when no listeners are subscribed', async () => {
      const fn = vi.fn(async () => 'ok');
      await expect(withActionProgress('launchApp', undefined, fn)).resolves.toBe('ok');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('assigns distinct ids to overlapping actions', async () => {
      const { events, unsubscribe } = collect();
      try {
        let releaseOuter!: () => void;
        const gate = new Promise<void>((resolve) => { releaseOuter = resolve; });
        const outer = withActionProgress('sessionReady', 'com.foo', async () => {
          await withActionProgress('startAgent', 'com.foo', async () => undefined);
          await gate;
        });
        releaseOuter();
        await outer;

        const starts = events.filter((e) => e.kind === 'start');
        expect(starts).toHaveLength(2);
        expect(starts[0].id).not.toBe(starts[1].id);
      } finally {
        unsubscribe();
      }
    });
  });
});
