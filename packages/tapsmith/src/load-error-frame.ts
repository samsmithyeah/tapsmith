/**
 * Point a "module not found" load error at the import that asked for it.
 *
 * A test file that imports a missing module fails inside the module resolver,
 * so the error's stack holds only resolver frames and reporters have no user
 * frame to show a code frame for (PILOT-545). The message does name the
 * specifier and the importing file, in one of the shapes Node, tsx and Vite
 * produce; this finds the import line in that file and adds a stack frame for
 * it, so the reporter's usual code-frame rendering shows the offending line.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

interface MissingImport {
  /** The specifier as written (tsx, Vite) or as resolved to a path (Node ESM). */
  specifier: string
  /** Absolute path of the file whose import failed. */
  importer: string
  /** A bare package name (Node's "Cannot find package"). */
  isPackage: boolean
}

const IMPORT_LINE_RE = /\b(import|require|from)\b/;
const STRING_LITERAL_RE = /(['"`])([^'"`\n]+)\1/g;

/**
 * Return `error` with a stack frame at the failing import prepended to its
 * frames when it is a missing-module error whose import line can be found.
 * Any other error, or one whose importer cannot be read, is returned as is.
 */
export function withMissingImportFrame(error: Error): Error {
  try {
    const missing = parseMissingImport(error.message);
    if (!missing) return error;
    const loc = findImportLocation(missing);
    if (!loc) return error;
    const frame = `    at ${missing.importer}:${loc.line}:${loc.column}`;
    const stack = error.stack ?? '';
    const lines = stack.split('\n');
    const firstFrame = lines.findIndex((l) => /^\s+at /.test(l));
    if (firstFrame === -1) {
      error.stack = stack ? `${stack}\n${frame}` : `${error.name}: ${error.message}\n${frame}`;
    } else {
      lines.splice(firstFrame, 0, frame);
      error.stack = lines.join('\n');
    }
  } catch {
    // Best effort: the error itself is what matters.
  }
  return error;
}

/** @internal — exported for unit testing. */
export function parseMissingImport(message: string): MissingImport | undefined {
  const head = /Cannot find (module|package) '([^']+)'/.exec(message);
  if (!head) return undefined;
  const isPackage = head[1] === 'package';
  const specifier = head[2];
  // Node ESM and Vite: "... imported from <importer>" (Vite quotes it).
  const importedFrom = /imported from '?([^'\n]+?)'?\s*$/m.exec(message);
  // tsx (CommonJS resolver): "Require stack:\n- <importer>\n- ...".
  const requireStack = /Require stack:\n- ([^\n]+)/.exec(message);
  const raw = importedFrom?.[1] ?? requireStack?.[1];
  if (!raw) return undefined;
  return { specifier, importer: toFilePath(raw.trim()), isPackage };
}

function toFilePath(raw: string): string {
  if (!raw.startsWith('file://')) return raw.replace(/\?.*$/, '');
  const url = new URL(raw);
  url.search = '';
  url.hash = '';
  return fileURLToPath(url);
}

function findImportLocation(missing: MissingImport): { line: number; column: number } | undefined {
  const source = fs.readFileSync(missing.importer, 'utf-8');
  const dir = path.dirname(missing.importer);
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!IMPORT_LINE_RE.test(line)) continue;
    for (const m of line.matchAll(STRING_LITERAL_RE)) {
      if (matchesSpecifier(m[2], missing, dir)) return { line: i + 1, column: (m.index ?? 0) + 1 };
    }
  }
  return undefined;
}

function matchesSpecifier(literal: string, missing: MissingImport, dir: string): boolean {
  if (literal === missing.specifier) return true;
  if (missing.isPackage) return literal.startsWith(`${missing.specifier}/`);
  // Node ESM reports the resolved path rather than the specifier as written.
  if (!path.isAbsolute(missing.specifier) || !literal.startsWith('.')) return false;
  const resolved = path.resolve(dir, literal);
  return resolved === missing.specifier || stripExt(resolved) === stripExt(missing.specifier);
}

function stripExt(p: string): string {
  return p.replace(/\.[cm]?[jt]sx?$/, '');
}
