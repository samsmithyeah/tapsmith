import { useEffect, useState } from 'react';

/**
 * The reset epoch, shared between `<TapsmithTestHooks />` (which bumps it after
 * every acknowledged reset) and screens that want to remount on reset.
 *
 * A warm reset clears storage and re-navigates, but React keeps component-local
 * state that survives navigation — a ScrollView's offset, an uncontrolled
 * input, an animation value. Keying such a component by the epoch remounts it
 * on every reset:
 *
 *     const epoch = useTapsmithResetEpoch();
 *     return <ScrollView key={epoch}>…</ScrollView>;
 */
let current = 0;
const listeners = new Set<(epoch: number) => void>();

/** @internal — called by TapsmithTestHooks after each reset. */
export function publishResetEpoch(epoch: number): void {
  if (epoch === current) return;
  current = epoch;
  for (const l of listeners) l(epoch);
}

/** @internal */
export function currentResetEpoch(): number {
  return current;
}

/** Subscribe to the reset epoch; returns the unsubscribe function. */
export function subscribeResetEpoch(listener: (epoch: number) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * The number of in-app resets acknowledged so far in this process (0 at
 * launch). Changes after every reset — use it as a React `key` on components
 * whose local state should not survive a reset.
 */
export function useTapsmithResetEpoch(): number {
  const [epoch, setEpoch] = useState(current);
  useEffect(() => subscribeResetEpoch(setEpoch), []);
  return epoch;
}
