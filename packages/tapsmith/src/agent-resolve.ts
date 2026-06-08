import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';

const require = createRequire(import.meta.url);

const AGENT_APK = 'app-debug.apk';
const AGENT_TEST_APK = 'app-debug-androidTest.apk';

const MONOREPO_RELATIVE_PATHS = [
  '../../agent/app/build/outputs/apk/debug',
  '../../../agent/app/build/outputs/apk/debug',
  '../../../../agent/app/build/outputs/apk/debug',
];

const MONOREPO_RELATIVE_TEST_PATHS = [
  '../../agent/app/build/outputs/apk/androidTest/debug',
  '../../../agent/app/build/outputs/apk/androidTest/debug',
  '../../../../agent/app/build/outputs/apk/androidTest/debug',
];

const NPM_PKG = '@tapsmith/agent-android';

function findFirst(filename: string, relativePaths: string[]): string | undefined {
  // 1. npm-installed package (e.g. @tapsmith/agent-android)
  try {
    const pkgJsonPath = require.resolve(`${NPM_PKG}/package.json`);
    const candidate = path.resolve(path.dirname(pkgJsonPath), filename);
    if (fs.existsSync(candidate)) return candidate;
  } catch {
    // Package not installed — fall through.
  }

  // 2. Monorepo build output
  for (const rel of relativePaths) {
    const candidate = path.resolve(import.meta.dirname, rel, filename);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function findAgentApk(): string | undefined {
  return findFirst(AGENT_APK, MONOREPO_RELATIVE_PATHS);
}

export function findAgentTestApk(): string | undefined {
  return findFirst(AGENT_TEST_APK, MONOREPO_RELATIVE_TEST_PATHS);
}
