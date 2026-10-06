/**
 * The dist-tag release.yml publishes every package under (PILOT-541). npm 11
 * refuses to publish a prerelease without `--tag`, and a prerelease published
 * as `latest` would become what a plain `npm install tapsmith` gets.
 */

import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { distTagFor } from '../../scripts/npm-dist-tag.mjs';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/npm-dist-tag.mjs');

describe('distTagFor', () => {
  it('publishes a release as latest', () => {
    expect(distTagFor('0.6.0')).toBe('latest');
    expect(distTagFor('12.0.3')).toBe('latest');
  });

  it('ignores build metadata', () => {
    expect(distTagFor('1.2.3+build.5')).toBe('latest');
    expect(distTagFor('1.2.3-beta.1+build.5')).toBe('beta');
  });

  it('publishes a prerelease under its first identifier', () => {
    expect(distTagFor('0.6.0-beta.1')).toBe('beta');
    expect(distTagFor('0.6.0-beta.0')).toBe('beta');
    expect(distTagFor('1.0.0-rc.2')).toBe('rc');
    expect(distTagFor('1.0.0-alpha')).toBe('alpha');
    expect(distTagFor('1.0.0-beta2')).toBe('beta2');
    expect(distTagFor('1.0.0-BETA.1')).toBe('beta');
    expect(distTagFor('1.0.0-next-gen.1')).toBe('next-gen');
  });

  it('falls back to next when the identifier cannot be a dist-tag', () => {
    // Numeric identifiers and semver ranges are refused by npm as tag names.
    expect(distTagFor('1.0.0-0')).toBe('next');
    expect(distTagFor('1.0.0-0.3.7')).toBe('next');
    expect(distTagFor('1.0.0-x.1')).toBe('next');
    expect(distTagFor('1.0.0-v2')).toBe('next');
    // Never publish a prerelease as the stable tag.
    expect(distTagFor('1.0.0-latest.1')).toBe('next');
  });

  it('accepts a leading v, as in the git tag', () => {
    expect(distTagFor('v0.6.0-beta.1')).toBe('beta');
    expect(distTagFor('v0.6.0')).toBe('latest');
  });

  it('refuses anything that is not a semver version', () => {
    for (const bad of ['', '0.6', '0.6.0-', 'beta', '0.6.0 beta', '01.2.3', '1.2.3-beta..1']) {
      expect(() => distTagFor(bad), bad).toThrow(/not a semver version/);
    }
  });
});

describe('npm-dist-tag.mjs CLI', () => {
  it('prints the tag for the version it is given', () => {
    const out = execFileSync(process.execPath, [script, '0.6.0-beta.1'], { encoding: 'utf8' });
    expect(out).toBe('beta\n');
  });

  it('exits non-zero with the reason for a bad version', () => {
    let error: unknown;
    try {
      execFileSync(process.execPath, [script, 'nope'], { encoding: 'utf8', stdio: 'pipe' });
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({ status: 1 });
    expect(String((error as { stderr: string }).stderr)).toMatch(/not a semver version/);
  });
});
