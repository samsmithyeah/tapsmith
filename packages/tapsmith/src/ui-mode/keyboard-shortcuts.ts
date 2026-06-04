// Pure resolution of UI-mode keyboard shortcuts, extracted so it can be
// unit-tested without rendering the whole app.

/** The action a bare-key shortcut maps to, or null for "no shortcut". */
export type ShortcutAction = 'run-all' | 'run-failed' | 'stop-run' | 'toggle-watch';

/** Minimal shape of a keyboard event we care about (subset of KeyboardEvent). */
export interface ShortcutKeyEvent {
  key: string
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  target?: EventTarget | null
}

/**
 * Decide which shortcut (if any) a keydown should trigger.
 *
 * Returns null — meaning "do nothing" — when:
 *  - the event carries a Cmd/Ctrl/Alt modifier. These combos belong to the
 *    browser/OS (e.g. Cmd+R reload, Cmd+Shift+R hard reload). Letting a bare
 *    `r` shortcut fire `run-all` during a reload kicks off a test run right as
 *    the page navigates away — the run then appears already in-progress after
 *    the page reconnects.
 *  - focus is in an input/textarea/select, where letters are real typing.
 */
export function resolveShortcut(e: ShortcutKeyEvent): ShortcutAction | null {
  // Never hijack a browser/OS chord (Cmd+R, Ctrl+R, Cmd+Shift+R, …).
  if (e.metaKey || e.ctrlKey || e.altKey) return null;

  const tag = (e.target as HTMLElement | null)?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return null;

  switch (e.key) {
    case 'r':
      return 'run-all';
    case 'f':
      return 'run-failed';
    case 'Escape':
      return 'stop-run';
    case 'w':
      return 'toggle-watch';
    default:
      return null;
  }
}
