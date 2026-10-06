/**
 * Native role names for `getByRole()` and `toHaveRole()` (PILOT-556).
 *
 * Browser-safe (no Node imports): the trace viewer / UI-mode locator
 * playground imports it too, so a role the playground accepts is exactly one
 * a test can use.
 *
 * **Parity contract:** `NATIVE_ROLES` is the union of the Android agent's
 * `roleClassMap` keys and `TRAIT_ONLY_ROLES` (`agent/.../ElementFinder.kt`)
 * and the iOS agent's `RoleMapping.roleToElementTypes` keys, and
 * `ROLE_ALIASES` matches both agents' alias maps. `roles.test.ts` reads the
 * agents' sources and fails on drift; the role table in `docs/locators.md`
 * is pinned to this list by `role-docs.test.ts`.
 *
 * WebView locators (`webview.getByRole`) query DOM ARIA roles and are not
 * checked against this list.
 */

// ─── Role set ───

/** Canonical native role names, sorted. */
export const NATIVE_ROLES: readonly string[] = [
  'alert',
  'button',
  'checkbox',
  'combobox',
  'heading',
  'image',
  'link',
  'list',
  'listitem',
  'progressbar',
  'radiobutton',
  'scrollview',
  'searchfield',
  'seekbar',
  'spinner',
  'switch',
  'tab',
  'text',
  'textfield',
  'toolbar',
];

/**
 * Cross-platform aliases: the React Native spelling → the canonical role.
 * Both agents normalize these the same way.
 */
export const ROLE_ALIASES: Readonly<Record<string, string>> = {
  header: 'heading',
  slider: 'seekbar',
  // RN's accessibilityRole="search" surfaces as a role description of
  // "search"; the canonical role is "searchfield".
  search: 'searchfield',
};

/**
 * Playwright ARIA role names whose native counterpart has another name, so
 * a test ported from Playwright gets pointed at the right one.
 */
const ARIA_ROLE_HINTS: Readonly<Record<string, string>> = {
  textbox: 'textfield',
  img: 'image',
  radio: 'radiobutton',
  searchbox: 'searchfield',
};

const KNOWN = new Set(NATIVE_ROLES);

// ─── Helpers ───

/** Lowercase a role and resolve an alias to its canonical name. */
export function normalizeRole(role: string): string {
  const lower = role.toLowerCase();
  return ROLE_ALIASES[lower] ?? lower;
}

/**
 * The error message for a role no element can have, or `null` when the role
 * is known. Matching is case-insensitive, like the agents.
 */
export function unknownRoleMessage(role: string): string | null {
  if (KNOWN.has(normalizeRole(role))) return null;
  const hint = ARIA_ROLE_HINTS[role.toLowerCase()];
  const aliases = Object.entries(ROLE_ALIASES).map(([alias, canonical]) => `${alias} → ${canonical}`).join(', ');
  return `Unknown role ${JSON.stringify(role)}.${hint ? ` Did you mean "${hint}"?` : ''} ` +
    `Supported: ${NATIVE_ROLES.join(', ')} (aliases: ${aliases}). ` +
    'For an element with no supported role, use getByText(), getByTestId() or getByDescription().';
}

/**
 * Throw when `role` is not a native role name. `what` names the API for the
 * TypeError a non-string gets (tests run through tsx are not type-checked).
 */
export function assertKnownRole(role: unknown, what: string): asserts role is string {
  if (typeof role !== 'string') {
    const got = role === null || role === undefined ? String(role) : `a ${typeof role}`;
    throw new TypeError(`${what} expects a role name string, got ${got}.`);
  }
  const message = unknownRoleMessage(role);
  if (message) throw new Error(message);
}
