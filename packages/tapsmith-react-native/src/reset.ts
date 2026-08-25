import type { ResetRequest } from './protocol.js';

/** Anything with a `clear()` (AsyncStorage) or `clearAll()` (MMKV) method. */
export type Clearable =
  | { clear: () => Promise<unknown> | unknown }
  | { clearAll: () => Promise<unknown> | unknown };

export type ResetHandler = (request: ResetRequest) => void | Promise<void>;

const handlers = new Set<ResetHandler>();

/**
 * Register a reset handler imperatively (an alternative to the `onReset`
 * prop, useful from non-React code). Returns an unsubscribe function.
 */
export function registerTapsmithReset(handler: ResetHandler): () => void {
  handlers.add(handler);
  return () => { handlers.delete(handler); };
}

export function registeredHandlers(): readonly ResetHandler[] {
  return [...handlers];
}

/** Clear every store, then run every handler, in order. Throws the first failure. */
export async function runResetPipeline(
  request: ResetRequest,
  clear: readonly Clearable[],
  handlers: readonly ResetHandler[],
): Promise<void> {
  for (const store of clear) {
    if ('clearAll' in store && typeof store.clearAll === 'function') await store.clearAll();
    else if ('clear' in store && typeof store.clear === 'function') await store.clear();
  }
  for (const handler of handlers) {
    await handler(request);
  }
}
