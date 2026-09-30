#!/usr/bin/env node
// Installs the packed tapsmith tarball into an empty project, the way a new
// user's first `npm install tapsmith` does, and fails if npm prints any
// `npm warn deprecated` line for the dependency tree (PILOT-405).
//
// Run after `npm run build`: `npm run check:clean-install`.
// Pass --keep to leave the scratch directory behind for inspection.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const keep = process.argv.includes('--keep');

if (!fs.existsSync(path.join(packageDir, 'dist', 'cli.js'))) {
  console.error('check-clean-install: dist/ is missing. Run `npm run build` first.');
  process.exit(1);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-clean-install-'));
const projectDir = path.join(scratch, 'project');
fs.mkdirSync(projectDir);
fs.writeFileSync(
  path.join(projectDir, 'package.json'),
  JSON.stringify({ name: 'clean-install-check', version: '0.0.0', private: true }, null, 2) + '\n',
);
// A fresh cache and an empty user config, so the result matches a first-time
// user's machine rather than whatever this one has cached or configured.
const userConfig = path.join(scratch, 'npmrc');
fs.writeFileSync(userConfig, '');
const env = {
  ...process.env,
  npm_config_cache: path.join(scratch, 'cache'),
  npm_config_userconfig: userConfig,
  npm_config_update_notifier: 'false',
  npm_config_fund: 'false',
  npm_config_audit: 'false',
};

function npm(args, cwd) {
  const result = spawnSync('npm', args, { cwd, env, encoding: 'utf8' });
  if (result.error) throw result.error;
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

let exitCode = 0;
try {
  const pack = npm(['pack', '--json', '--ignore-scripts', '--pack-destination', scratch], packageDir);
  if (pack.status !== 0) {
    console.error(pack.output);
    throw new Error('npm pack failed');
  }
  const [{ filename }] = JSON.parse(pack.output.slice(pack.output.indexOf('[')));
  const tarball = path.join(scratch, filename);

  const install = npm(['install', '--ignore-scripts', tarball], projectDir);
  const deprecated = install.output
    .split(/\r?\n/)
    .filter((line) => /^npm warn deprecated /i.test(line));

  if (install.status !== 0) {
    console.error(install.output);
    console.error(`check-clean-install: npm install ${filename} failed (exit ${install.status}).`);
    exitCode = 1;
  } else if (deprecated.length > 0) {
    console.error(`check-clean-install: installing ${filename} into an empty project prints deprecation warnings:\n`);
    for (const line of deprecated) console.error(`  ${line}`);
    console.error(
      '\nEvery new user sees these on their first install. Upgrade or replace the dependency that pulls the\n' +
        'deprecated package in (`npm ls <name>` in packages/tapsmith shows the path).',
    );
    exitCode = 1;
  } else {
    console.log(`check-clean-install: ${filename} installs into an empty project with no deprecation warnings.`);
  }
} catch (err) {
  console.error(`check-clean-install: ${err instanceof Error ? err.message : String(err)}`);
  exitCode = 1;
} finally {
  if (keep) console.log(`check-clean-install: scratch directory kept at ${scratch}`);
  else fs.rmSync(scratch, { recursive: true, force: true });
}
process.exit(exitCode);
