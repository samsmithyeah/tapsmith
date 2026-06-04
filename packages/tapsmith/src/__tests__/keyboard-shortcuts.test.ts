import { describe, expect, it } from 'vitest';
import { resolveShortcut } from '../ui-mode/keyboard-shortcuts.js';

describe('resolveShortcut', () => {
  it('maps bare letter/Escape keys to actions', () => {
    expect(resolveShortcut({ key: 'r' })).toBe('run-all');
    expect(resolveShortcut({ key: 'f' })).toBe('run-failed');
    expect(resolveShortcut({ key: 'w' })).toBe('toggle-watch');
    expect(resolveShortcut({ key: 'Escape' })).toBe('stop-run');
  });

  it('ignores unmapped keys', () => {
    expect(resolveShortcut({ key: 'x' })).toBeNull();
    expect(resolveShortcut({ key: 'a' })).toBeNull();
  });

  // Regression: Cmd+Shift+R (hard refresh) was firing run-all over the
  // websocket right before the page reloaded, so tests appeared to start
  // running on refresh.
  it('does not fire a shortcut for browser reload chords', () => {
    expect(resolveShortcut({ key: 'r', metaKey: true })).toBeNull(); // Cmd+R
    expect(resolveShortcut({ key: 'r', metaKey: true, shiftKey: true })).toBeNull(); // Cmd+Shift+R
    expect(resolveShortcut({ key: 'R', metaKey: true })).toBeNull(); // shift-cased variant
    expect(resolveShortcut({ key: 'r', ctrlKey: true })).toBeNull(); // Ctrl+R
    expect(resolveShortcut({ key: 'Escape', shiftKey: true })).toBeNull(); // Shift+Escape (task manager)
  });

  it('ignores any modifier-bearing key', () => {
    expect(resolveShortcut({ key: 'f', metaKey: true })).toBeNull();
    expect(resolveShortcut({ key: 'w', altKey: true })).toBeNull();
  });

  it('ignores keys while typing in form fields or editable elements', () => {
    expect(resolveShortcut({ key: 'r', target: { tagName: 'INPUT' } as never })).toBeNull();
    expect(resolveShortcut({ key: 'r', target: { tagName: 'TEXTAREA' } as never })).toBeNull();
    expect(resolveShortcut({ key: 'r', target: { tagName: 'SELECT' } as never })).toBeNull();
    expect(resolveShortcut({ key: 'r', target: { isContentEditable: true } as never })).toBeNull();
  });
});
