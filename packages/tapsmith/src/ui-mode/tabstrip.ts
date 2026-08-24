/**
 * Keyboard navigation for a tab strip: Left/Right move between tabs, Home/End
 * jump to the ends.
 *
 * Tabs stay individually tabbable rather than using APG's roving-tabindex
 * pattern. Several of the app's tab strips are plain `<button>`s and so are
 * already in the tab order; switching to roving would make Tab skip the whole
 * group, changing behaviour that already works for keyboard users. Arrow keys
 * are purely additive.
 *
 * Returns the index to activate, or null if the key isn't a navigation key.
 */
export function nextTabIndex(key: string, current: number, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case 'ArrowRight':
      return (current + 1) % count;
    case 'ArrowLeft':
      return (current - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/**
 * Move focus to the nth sibling of the element the event fired on. Tab strips
 * follow focus, or a second arrow press would move from the old position.
 */
export function focusSibling(e: { currentTarget: EventTarget | null }, index: number): void {
  const el = e.currentTarget as HTMLElement | null;
  const sibling = el?.parentElement?.children[index] as HTMLElement | undefined;
  sibling?.focus();
}
