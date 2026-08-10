import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

/**
 * Loader resolution for the child processes that discover and run test files.
 *
 * Those children `import()` the project's test files, so the decision must be
 * driven by the *test files*, not by whether our own forked script happens to
 * be TypeScript. Bare node resolves a `.ts` file (native type stripping) but
 * does not remap a `./x.js` specifier to `x.ts` the way tsx does — so a
 * TypeScript suite whose files import each other the ESM way fails to load
 * entirely when it is forked without the loader.
 */

function isTypeScript(file: string): boolean {
  return file.endsWith('.ts') || file.endsWith('.tsx');
}

/** Whether the forked children need the tsx loader. */
export function needsTsxLoader(scriptPaths: string[], testFiles: string[]): boolean {
  return scriptPaths.some(isTypeScript) || testFiles.some(isTypeScript);
}

/**
 * Find the tsx executable. npm may keep it under our own package, hoist it to
 * the consumer's `node_modules/.bin`, or leave it reachable only through the
 * package itself — check every shape rather than assuming one, since guessing
 * wrong forks bare node and breaks TypeScript imports silently.
 */
export function resolveTsxBin(tapsmithPkgDir: string): string | undefined {
  const candidates = [
    // Our own dependency tree (source checkout, or an un-hoisted install).
    path.join(tapsmithPkgDir, 'node_modules', '.bin', 'tsx'),
    // Hoisted next to us: <node_modules>/.bin/tsx when we are <node_modules>/tapsmith.
    path.resolve(tapsmithPkgDir, '..', '.bin', 'tsx'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  // The package may be resolvable even when no .bin shim is reachable from here.
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve('tsx/package.json');
    const bin = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).bin;
    const relative = typeof bin === 'string' ? bin : bin?.tsx;
    if (relative) {
      const resolved = path.resolve(path.dirname(pkgPath), relative);
      if (fs.existsSync(resolved)) return resolved;
    }
  } catch {
    // Not resolvable from here — fall through to PATH.
  }

  return findExecutableOnPath('tsx');
}

/**
 * The loader for a set of forked scripts, or `undefined` when none is needed.
 * Reports through `onMissing` when TypeScript tests are present but no tsx
 * could be found — the children would otherwise fail one by one with module
 * resolution errors that look nothing like the real cause.
 */
export function resolveChildLoader(
  scriptPaths: string[],
  testFiles: string[],
  tapsmithPkgDir: string,
  onMissing?: (message: string) => void,
): string | undefined {
  if (!needsTsxLoader(scriptPaths, testFiles)) return undefined;

  const tsxBin = resolveTsxBin(tapsmithPkgDir);
  if (!tsxBin) {
    // Name whichever side actually needs it. Blaming the test files when the
    // suite is entirely JavaScript sends the reader looking in the wrong place.
    const source = testFiles.some(isTypeScript)
      ? 'TypeScript test files were found'
      : "Tapsmith's own child scripts are TypeScript";
    onMissing?.(
      `${source} but the tsx loader could not be located. `
      + 'Test discovery and runs will fail for any file importing a sibling module '
      + '(e.g. `import { test } from "./fixtures.js"`). Install tsx: npm install -D tsx',
    );
  }
  return tsxBin;
}

function findExecutableOnPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Not in this directory.
    }
  }
  return undefined;
}
