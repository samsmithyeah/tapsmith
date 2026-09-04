import { describe, expect, it } from 'vitest';
import { currentResetEpoch, publishResetEpoch, subscribeResetEpoch } from '../epoch.js';

describe('reset epoch store', () => {
  it('publishes each new epoch to subscribers and ignores repeats', () => {
    const seen: number[] = [];
    const unsubscribe = subscribeResetEpoch((e) => seen.push(e));
    const start = currentResetEpoch();
    publishResetEpoch(start + 1);
    publishResetEpoch(start + 1);
    publishResetEpoch(start + 2);
    expect(seen).toEqual([start + 1, start + 2]);
    expect(currentResetEpoch()).toBe(start + 2);
    unsubscribe();
    publishResetEpoch(start + 3);
    expect(seen).toEqual([start + 1, start + 2]);
  });
});
