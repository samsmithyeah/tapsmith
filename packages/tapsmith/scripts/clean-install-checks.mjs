// Pure checks behind check-clean-install.mjs, kept apart so the unit tests
// (src/__tests__/clean-install-checks.test.ts) can pin them without packing or
// installing anything.

// ─── Install-script warnings (PILOT-437) ───

/**
 * Third-party packages whose install scripts a fresh `npm install tapsmith`
 * may report, and why each is fine left unapproved (npm 12 blocks them).
 * docs/getting-started.md tells users the same. Our own packages never belong
 * here: a Tapsmith package with an install script is always a failure.
 */
export const ALLOWED_INSTALL_SCRIPTS = Object.freeze({
  protobufjs:
    'via @grpc/proto-loader and @grpc/grpc-js; its postinstall only prints a version-scheme advisory, so blocking it changes nothing',
  esbuild:
    'via tsx (TypeScript config loading); its install.js only verifies the @esbuild/<platform> binary npm already installed, and esbuild runs without it',
  fsevents:
    'via tsx, macOS only; npm infers `node-gyp rebuild` from its binding.gyp, but the package ships a prebuilt fsevents.node',
});

// `npm warn allow-scripts   <name>@<version> (<event>: <command>)` on npm
// 11.17+, `npm warn install-scripts …` once npm 12 blocks them. The header,
// blank and advice lines have no name@version after the run of spaces.
const INSTALL_SCRIPT_ENTRY = /^npm warn (?:allow-scripts|install-scripts) {2,}((?:@[^\s/@]+\/)?[^\s/@]+)@(\S+)(?: \(.*\))?\s*$/i;

/** Every package an install-scripts warning in `output` names. */
export function parseInstallScriptWarnings(output) {
  const entries = [];
  for (const line of output.split(/\r?\n/)) {
    const match = INSTALL_SCRIPT_ENTRY.exec(line);
    if (match) entries.push({ name: match[1], version: match[2], line });
  }
  return entries;
}

/** The entries that are not allowlisted. A `@tapsmith/` package never is. */
export function disallowedInstallScripts(entries, allowed = ALLOWED_INSTALL_SCRIPTS) {
  return entries.filter(
    (entry) => entry.name.startsWith('@tapsmith/') || !Object.hasOwn(allowed, entry.name),
  );
}

/**
 * npm 11.17.0 is the first release that reports install scripts at all; on
 * anything older the install-scripts check cannot fail, so it must not pass
 * quietly either. Prereleases are treated as older.
 */
export function npmReportsInstallScripts(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) return false;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major > 11 || (major === 11 && minor >= 17);
}

// ─── Deprecations (PILOT-405) ───

/** The `npm warn deprecated` lines in `output`. */
export function deprecationLines(output) {
  return output.split(/\r?\n/).filter((line) => /^npm warn deprecated /i.test(line));
}

// ─── Package contents (PILOT-437, PILOT-438) ───

/**
 * The one package's entry from `npm pack --json` stdout: npm 11 prints an
 * array of entries, npm 12 an object keyed by package name.
 */
export function packEntry(stdout) {
  const parsed = JSON.parse(stdout);
  const entries = Array.isArray(parsed) ? parsed : Object.values(parsed ?? {});
  if (entries.length !== 1 || typeof entries[0]?.filename !== 'string') {
    throw new Error(`unexpected \`npm pack --json\` output: ${stdout.slice(0, 200)}`);
  }
  return entries[0];
}

/** Paths in `npm pack --json` files that sit under a `__tests__` directory. */
export function testPaths(files) {
  return files.map((file) => file.path).filter((p) => p.split('/').includes('__tests__'));
}

/** The lifecycle scripts npm runs on install that a package.json declares. */
export function installScriptsOf(pkg) {
  return ['preinstall', 'install', 'postinstall'].filter((name) => pkg.scripts?.[name] !== undefined);
}

/**
 * Of `names`, the files in `npm pack --json` output that are missing or not
 * executable by owner, group and other. npm keeps the tarball's modes on
 * install, so these bits are all that makes the daemon runnable.
 */
export function nonExecutableFiles(files, names) {
  const problems = [];
  for (const name of names) {
    const file = files.find((f) => f.path === name);
    if (!file) problems.push(`${name} (not in the tarball)`);
    else if ((file.mode & 0o111) !== 0o111) problems.push(`${name} (mode ${(file.mode & 0o777).toString(8)})`);
  }
  return problems;
}
