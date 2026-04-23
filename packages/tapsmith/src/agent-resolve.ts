import * as fs from 'node:fs';
import * as path from 'node:path';

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

function findFirst(filename: string, relativePaths: string[]): string | undefined {
  const bundled = path.resolve(__dirname, 'agents/android', filename);
  if (fs.existsSync(bundled)) return bundled;

  for (const rel of relativePaths) {
    const candidate = path.resolve(__dirname, rel, filename);
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
