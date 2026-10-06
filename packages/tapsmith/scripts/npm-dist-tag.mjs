#!/usr/bin/env node
// The npm dist-tag release.yml publishes every package under (PILOT-541).
//
//   node packages/tapsmith/scripts/npm-dist-tag.mjs 0.6.0-beta.1   # prints "beta"
//
// npm 11 refuses to publish a prerelease without `--tag`, and every package of
// one release must share the tag: `tapsmith` pins its @tapsmith/* optional
// dependencies to the exact version, but `npm install @tapsmith/core-…@beta`
// and `npm view` should agree with it. A stable release goes to `latest`; a
// prerelease goes to its first identifier (`0.6.0-beta.1` → `beta`), so a
// plain `npm install tapsmith` never picks up a prerelease.
//
// Unit-tested by src/__tests__/npm-dist-tag.test.ts.

import { fileURLToPath } from 'node:url';

// semver.org's recommended pattern, with an optional leading `v` (git tags).
const SEMVER =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

// npm refuses a tag that is also a valid semver range (`1`, `x`, `v2`), and
// `latest` would make the prerelease the default install.
const USABLE_TAG = /^[a-z][a-z0-9-]*$/;
const RANGE_LIKE = /^(?:x|v\d.*)$/;

/**
 * @param {string} version a semver version, optionally `v`-prefixed
 * @returns {string} the dist-tag to publish it under
 */
export function distTagFor(version) {
  const match = SEMVER.exec(version);
  if (!match) throw new Error(`'${version}' is not a semver version (expected e.g. 0.6.0 or 0.6.0-beta.1)`);
  const prerelease = match[4];
  if (prerelease === undefined) return 'latest';
  const id = prerelease.split('.')[0].toLowerCase();
  if (!USABLE_TAG.test(id) || RANGE_LIKE.test(id) || id === 'latest') return 'next';
  return id;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    console.log(distTagFor(process.argv[2] ?? ''));
  } catch (e) {
    console.error(`npm-dist-tag: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
