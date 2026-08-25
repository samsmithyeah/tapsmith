/**
 * App reset policy — the mobile analogue of Playwright's per-test browser
 * context.
 *
 * A policy says *how* the app under test is brought to a known state
 * (`mode`) and *how often* (`scope`). It is resolved once per suite scope from
 * config + `projects[].use` + `test.use()` and then executed by the runner as
 * traced fixture setup (see `session-preflight.ts` `executeAppReset`).
 *
 * This module holds only types and pure functions so it can be shared by the
 * runner, the UI server (tree glyphs, background preparation) and tests.
 */

import * as path from 'node:path';
import type { AppResetMode, AppResetScope, TapsmithConfig } from './config.js';

/** `appReset` with `'auto'` resolved away. */
export type ResolvedAppResetMode = Exclude<AppResetMode, 'auto'>;
/** `appResetScope` with `'auto'` resolved away. */
export type ResolvedAppResetScope = Exclude<AppResetScope, 'auto'>;

export interface AppResetPolicy {
  mode: ResolvedAppResetMode;
  scope: ResolvedAppResetScope;
  /**
   * Saved app state to restore (absolute path). `''` means "clear app data"
   * (an explicit fresh, unauthenticated start); `undefined` means the scope
   * declared no app state and `mode` alone applies.
   */
  appState?: string;
}

/** What the device/session can offer, discovered at runtime. */
export interface ResetCapabilities {
  /** `@tapsmith/react-native` reset hooks were detected in the app's UI hierarchy. */
  hooksDetected?: boolean;
  /** Physical device (not a simulator/emulator). */
  isPhysical?: boolean;
}

/**
 * A reset that already happened, e.g. the startup launch of a freshly
 * installed app or a background preparation in UI mode. The runner compares
 * it against the policy a file/test asks for and skips the inline reset when
 * it is satisfied (recording the fact in the trace).
 */
export interface PreparedState {
  policy: AppResetPolicy;
  /** Wall-clock time the preparation finished. */
  preparedAt: number;
  /** How long the preparation took. */
  durationMs: number;
  /** Human-readable source, e.g. "startup launch" or "background preparation". */
  source: string;
}

/** Where the work behind a recorded reset step happened. */
export type AppResetOrigin = 'inline' | 'prepared' | 'skipped';

export interface AppResetStep {
  name: string;
  durationMs: number;
  ok: boolean;
  detail?: string;
}

export interface AppResetReport {
  policy: AppResetPolicy;
  origin: AppResetOrigin;
  /** The mode that actually ran (may differ from `policy.mode` after a fallback). */
  modeUsed: ResolvedAppResetMode | 'restore';
  fellBack: boolean;
  /** Human-readable explanation for a fallback or a skipped reset. */
  reason?: string;
  durationMs: number;
  steps: AppResetStep[];
}

/**
 * Resolve the effective policy for a scope.
 *
 * `scopeOptions.appState` is the scope's own `test.use({ appState })` (not
 * cascaded — a nested describe without `appState` declares none, as before).
 * `appReset` / `appResetScope` are ordinary config keys and arrive already
 * cascaded through `config` (root → project `use` → `test.use()`).
 */
export function resolveAppResetPolicy(
  scopeOptions: { appState?: string } | undefined,
  config: Pick<TapsmithConfig, 'appReset' | 'appResetScope' | 'resetAppDeepLink' | 'rootDir'>,
  caps: ResetCapabilities = {},
): AppResetPolicy {
  const warmAvailable = !!caps.hooksDetected || !!config.resetAppDeepLink;

  const requestedMode = config.appReset ?? 'auto';
  const mode: ResolvedAppResetMode = requestedMode === 'auto'
    ? (warmAvailable ? 'warm' : 'clear')
    : requestedMode;

  const requestedScope = config.appResetScope ?? 'auto';
  const scope: ResolvedAppResetScope = requestedScope === 'auto'
    ? (caps.hooksDetected ? 'test' : 'file')
    : requestedScope;

  const policy: AppResetPolicy = { mode, scope };
  const appState = scopeOptions?.appState;
  if (appState !== undefined) {
    policy.appState = appState === ''
      ? ''
      : (path.isAbsolute(appState) ? appState : path.resolve(config.rootDir, appState));
  }
  return policy;
}

/**
 * The concrete action a policy implies. `appState` takes precedence over
 * `mode`: a non-empty archive means "restore", an empty string means "clear".
 */
export type AppResetAction =
  | { kind: 'restore'; archive: string }
  | { kind: 'clear' }
  | { kind: 'restart' }
  | { kind: 'warm' }
  | { kind: 'none' };

export function appResetAction(policy: AppResetPolicy): AppResetAction {
  if (policy.appState !== undefined) {
    return policy.appState === '' ? { kind: 'clear' } : { kind: 'restore', archive: policy.appState };
  }
  return { kind: policy.mode };
}

/**
 * Whether a device already in state `have` satisfies what `want` asks for.
 *
 * Lattice: `clear` (fresh install state) satisfies every mode-only policy;
 * `restart` and `warm` satisfy themselves and `none`; `none` satisfies only
 * `none`. A restored archive satisfies only the identical archive — and a
 * plain `clear` never satisfies a restore (the restore owns that state).
 */
export function satisfies(have: AppResetPolicy, want: AppResetPolicy): boolean {
  const h = appResetAction(have);
  const w = appResetAction(want);
  if (w.kind === 'restore') return h.kind === 'restore' && h.archive === w.archive;
  if (h.kind === 'restore') return w.kind === 'none';
  if (w.kind === 'none') return true;
  if (h.kind === 'clear') return true;
  return h.kind === w.kind;
}

export function appResetPolicyEquals(a: AppResetPolicy | undefined, b: AppResetPolicy | undefined): boolean {
  if (!a || !b) return a === b;
  return a.mode === b.mode && a.scope === b.scope && a.appState === b.appState;
}

/** Trace-friendly action label: "App reset (clear)". */
export function describeAction(policy: AppResetPolicy): string {
  const action = appResetAction(policy);
  return action.kind === 'restore'
    ? `App reset (restore ${path.basename(action.archive)})`
    : `App reset (${action.kind})`;
}
