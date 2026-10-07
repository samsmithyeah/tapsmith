/**
 * Docs guard (PILOT-556): every native `getByRole("…")` the docs, the
 * website or the SDK's own generated code show must use a role getByRole
 * accepts, and the role table in docs/locators.md must list exactly those
 * roles. A copied example that names an unsupported role throws at once
 * now, which is no better for a first-time user than the 30s wait it used
 * to cause.
 *
 * WebView locators (`webview.getByRole`, and anything built from
 * `device.webview()`) query DOM ARIA roles and are skipped.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { glob } from 'glob';
import { describe, expect, it } from 'vitest';
import { NATIVE_ROLES, ROLE_ALIASES, unknownRoleMessage } from '../roles.js';

const REPO = path.resolve(import.meta.dirname, '../../../..');

const SOURCES = [
  'docs/**/*.md', '*.md', 'packages/*/README.md', 'website/*.md',
  'website/src/**/*.{astro,md,mdx}',
  'packages/tapsmith/src/**/*.{ts,tsx}',
  'e2e/**/*.ts',
];

/** Files git tracks, plus new ones not yet added — never ignored ones. */
function repoFiles(): Set<string> | undefined {
  try {
    return new Set(
      execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
        .split('\n').filter(Boolean),
    );
  } catch {
    return undefined;
  }
}

function sourceFiles(): string[] {
  const tracked = repoFiles();
  return glob.sync(SOURCES, { cwd: REPO, nodir: true, ignore: ['**/node_modules/**', '**/__tests__/**', '**/dist/**'] })
    .filter((rel) => (tracked ? tracked.has(rel) : true))
    .sort();
}

interface RoleUse {
  file: string;
  line: number;
  role: string;
  /** The source line, for the failure message. */
  text: string;
}

const lineAt = (source: string, offset: number): number => source.slice(0, offset).split('\n').length;

/**
 * The receiver chain a `getByRole(` call at `offset` hangs off, joined
 * across the lines that continue it (`.getByRole` on a line of its own).
 */
function chainBefore(source: string, offset: number): string {
  const lines = source.slice(0, offset).split('\n');
  let chain = lines.pop() ?? '';
  while (/^\s*\./.test(chain) && lines.length > 0) chain = `${lines.pop()!}${chain.trim()}`;
  return chain;
}

/**
 * The member-chain expression that ends `chain` (which ends just before
 * `getByRole`): walk back over identifiers, dots, whitespace and balanced
 * brackets.
 */
function chainExpression(chain: string): string {
  let i = chain.length - 1;
  let depth = 0;
  for (; i >= 0; i--) {
    const c = chain[i]!;
    if (c === ')' || c === ']') depth++;
    else if (c === '(' || c === '[') {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && !/[\w$.\s]/.test(c)) break;
  }
  return chain.slice(i + 1);
}

/**
 * Whether the chain is a WebView locator: it mentions `webview`, or its root
 * variable was assigned from something that does (following variables).
 */
function isWebViewChain(source: string, offset: number, chain: string, hops = 3): boolean {
  const expression = chainExpression(chain);
  if (/webview/i.test(expression)) return true;
  const root = /^\s*(?:await\s+)?([A-Za-z_$][\w$]*)/.exec(expression)?.[1];
  if (!root || root === 'device' || hops === 0) return false;
  const before = source.slice(0, offset);
  const decl = [...before.matchAll(new RegExp(`(?:const|let|var)\\s+${root.replace(/\$/g, '\\$')}\\s*=([^\\n;]*)`, 'g'))].pop();
  if (!decl) return false;
  return isWebViewChain(source, decl.index!, `${decl[1]!}.`, hops - 1);
}

function nativeRoleUses(rel: string, source: string): RoleUse[] {
  const uses: RoleUse[] = [];
  // A role name has no whitespace or commas, which keeps prose like
  // "(`device.getByRole(`, `device.tap(`" out.
  for (const m of source.matchAll(/getByRole\(\s*(['"`])([^'"`\s,]*)\1/g)) {
    const role = m[2]!;
    // A template substitution or a message placeholder, not a role name.
    if (role.includes('${') || role.includes('{{')) continue;
    const offset = m.index!;
    if (isWebViewChain(source, offset, chainBefore(source, offset))) continue;
    const line = lineAt(source, offset);
    uses.push({ file: rel, line, role, text: source.split('\n')[line - 1]!.trim() });
  }
  return uses;
}

// ─── Role table ───

/** Role names in the docs/locators.md role table (`seekbar` / `slider` gives both). */
function tableRoles(): string[] {
  const source = fs.readFileSync(path.join(REPO, 'docs/locators.md'), 'utf8');
  const start = source.indexOf('| Role | Android classes | iOS types |');
  expect(start, 'docs/locators.md has no role table').toBeGreaterThanOrEqual(0);
  const roles: string[] = [];
  for (const row of source.slice(start).split('\n').slice(2)) {
    if (!row.startsWith('|')) break;
    const first = row.split('|')[1]!;
    roles.push(...[...first.matchAll(/`([^`]+)`/g)].map((m) => m[1]!));
  }
  return roles;
}

describe('role docs (PILOT-556)', () => {
  it('lists every native role, and only those, in the docs/locators.md role table', () => {
    const roles = tableRoles();
    const canonical = roles.filter((r) => !(r in ROLE_ALIASES));
    expect(canonical.sort()).toEqual([...NATIVE_ROLES]);
    for (const alias of roles.filter((r) => r in ROLE_ALIASES)) {
      expect(roles, `alias "${alias}" should share a row with its role`).toContain(ROLE_ALIASES[alias]);
    }
  });

  it('uses only supported roles in native getByRole samples', () => {
    const uses = sourceFiles().flatMap((rel) => nativeRoleUses(rel, fs.readFileSync(path.join(REPO, rel), 'utf8')));
    // Guard against the scan silently finding nothing.
    expect(uses.length).toBeGreaterThan(100);
    const bad = uses.filter((u) => unknownRoleMessage(u.role) !== null);
    expect(bad.map((u) => `${u.file}:${u.line}: getByRole("${u.role}") — ${u.text}`)).toEqual([]);
  });
});

describe('role docs scanner', () => {
  const uses = (source: string) => nativeRoleUses('x.md', source).map((u) => u.role);

  it('finds native calls on device and on scoped locators', () => {
    expect(uses('await device.getByRole("button").tap()\nconst row = device.getByTestId("r")\nrow.getByRole(\'lst\')')).toEqual(['button', 'lst']);
  });

  it('follows a chain continued on the next line', () => {
    expect(uses('device\n  .getByTestId("r")\n  .getByRole("menu")')).toEqual(['menu']);
  });

  it('skips WebView chains, directly or through a variable', () => {
    expect(uses('await webview.getByRole("banner").tap()')).toEqual([]);
    expect(uses('const wv = await device.webview()\nconst form = wv.locator("form")\nawait wv.getByRole("banner").tap()')).toEqual([]);
    expect(uses('const page = await device.webview()\nawait page.getByRole("banner").tap()')).toEqual([]);
  });

  it('skips template substitutions', () => {
    expect(uses('`device.getByRole("${role}")`')).toEqual([]);
  });
});
