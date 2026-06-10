/**
 * `tapsmith verify` — end-to-end smoke proof of the configured setup.
 *
 * Spawns the real `tapsmith test` path (daemon spawn, emulator launch, app
 * install all included) on a single test file with the JSON reporter
 * redirected to a temp file, then reports a structured verdict. If the
 * project has no test files yet, a throwaway smoke test is scaffolded and
 * cleaned up afterwards.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ─── Pure helpers (unit-tested) ───

export interface VerifyArgs {
  json: boolean;
  config: string | undefined;
}

export function parseVerifyArgs(argv: string[]): VerifyArgs {
  const args: VerifyArgs = { json: false, config: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--config' || arg === '-c') args.config = argv[++i];
    else if (arg.startsWith('--config=')) args.config = arg.slice('--config='.length);
    else throw new Error(`Unknown verify flag: ${arg} (usage: tapsmith verify [--json] [--config <file>])`);
  }
  return args;
}

export function pickVerifyTarget(testFiles: string[]): string | undefined {
  return testFiles.find((f) => path.basename(f) === 'example.test.ts') ?? testFiles[0];
}

interface ReportTest {
  fullName: string;
  status: 'passed' | 'failed' | 'skipped';
  error?: { message: string };
  screenshotPath?: string;
}

interface ReportSuite {
  tests: ReportTest[];
  suites: ReportSuite[];
}

interface VerifyReport {
  stats: { passed: number; failed: number; skipped: number; duration: number };
  suites: ReportSuite[];
}

export interface VerifySummary {
  ok: boolean;
  passed: number;
  failed: number;
  skipped: number;
  duration: number;
  failures: Array<{ fullName: string; error: string; screenshotPath?: string }>;
}

export function summarizeVerifyReport(report: VerifyReport): VerifySummary {
  const failures: VerifySummary['failures'] = [];
  const walk = (suite: ReportSuite): void => {
    for (const t of suite.tests) {
      if (t.status === 'failed') {
        failures.push({ fullName: t.fullName, error: t.error?.message ?? 'unknown error', screenshotPath: t.screenshotPath });
      }
    }
    suite.suites.forEach(walk);
  };
  report.suites.forEach(walk);
  return {
    ok: report.stats.failed === 0,
    passed: report.stats.passed,
    failed: report.stats.failed,
    skipped: report.stats.skipped,
    duration: report.stats.duration,
    failures,
  };
}

// ─── Command entry ───

function emitError(json: boolean, code: string, message: string, fix?: string): void {
  if (json) {
    console.log(JSON.stringify({ error: { code, message, fix } }, null, 2));
  } else {
    console.error(`✗ ${message}`);
    if (fix) console.error(`→ ${fix}`);
  }
  process.exitCode = 1;
}

export async function runVerify(argv: string[]): Promise<void> {
  let args: VerifyArgs;
  try {
    args = parseVerifyArgs(argv);
  } catch (err) {
    emitError(argv.includes('--json'), 'BAD_ARGS', err instanceof Error ? err.message : String(err));
    return;
  }

  const { loadConfig } = await import('./config.js');
  let config;
  try {
    config = await loadConfig(undefined, args.config);
  } catch (err) {
    emitError(args.json, 'CONFIG_ERROR', `Could not load config: ${err instanceof Error ? err.message : String(err)}`,
      'Run: npx tapsmith init --yes (or npx tapsmith doctor --json to diagnose)');
    return;
  }

  const { discoverTestFiles } = await import('./test-file-discovery.js');
  const testFiles = await discoverTestFiles(config.testMatch, config.rootDir);

  let target = pickVerifyTarget(testFiles);
  let scaffolded: string | undefined;
  if (!target) {
    // No tests yet — scaffold a throwaway smoke test (cleaned up below).
    const { generateExampleTest } = await import('./init.js');
    const testDir = path.join(config.rootDir, 'tests');
    scaffolded = path.join(testDir, 'tapsmith-verify-smoke.test.ts');
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(scaffolded, generateExampleTest());
    target = scaffolded;
  }

  const resultsFile = path.join(os.tmpdir(), `tapsmith-verify-${process.pid}.json`);
  if (!args.json) {
    console.log(`Verifying setup with ${path.relative(config.rootDir, target)} ...`);
  }

  try {
    const child = spawnSync(process.execPath, [
      process.argv[1], 'test', target, '--reporter', 'json',
      ...(args.config ? ['--config', args.config] : []),
    ], {
      stdio: args.json ? 'pipe' : 'inherit',
      env: { ...process.env, TAPSMITH_JSON_OUTPUT_FILE: resultsFile },
      timeout: 10 * 60 * 1000,
    });

    if (!fs.existsSync(resultsFile)) {
      const stderr = child.stderr ? child.stderr.toString().slice(-2000) : undefined;
      emitError(args.json, 'RUN_FAILED',
        `Test run produced no results (exit code ${child.status ?? 'unknown'})${stderr ? `: ${stderr}` : ''}`,
        'Run: npx tapsmith doctor --json to diagnose the environment');
      return;
    }

    const report = JSON.parse(fs.readFileSync(resultsFile, 'utf8')) as VerifyReport;
    const summary = summarizeVerifyReport(report);

    if (args.json) {
      console.log(JSON.stringify({ ...summary, testFile: path.relative(config.rootDir, target) }, null, 2));
    } else {
      console.log(summary.ok
        ? `✓ Setup verified: ${summary.passed} test(s) passed in ${(summary.duration / 1000).toFixed(1)}s`
        : `✗ Verification failed: ${summary.failed} of ${summary.passed + summary.failed} test(s) failed`);
      for (const f of summary.failures) console.log(`  - ${f.fullName}: ${f.error}`);
    }
    if (!summary.ok) process.exitCode = 1;
  } finally {
    fs.rmSync(resultsFile, { force: true });
    if (scaffolded) fs.rmSync(scaffolded, { force: true });
  }
}
