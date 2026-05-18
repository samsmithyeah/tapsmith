import * as path from 'node:path';
import { glob } from 'glob';

export async function discoverTestFiles(
  patterns: string[],
  rootDir: string,
  explicitFiles?: string[],
  extraIgnore?: string[],
): Promise<string[]> {
  if (explicitFiles && explicitFiles.length > 0) {
    return explicitFiles.map((f) => path.resolve(rootDir, f));
  }

  const ignore = ['**/node_modules/**', '**/dist/**', ...(extraIgnore ?? [])];
  const files: string[] = [];
  for (const pattern of patterns) {
    const matches = await glob(pattern, {
      cwd: rootDir,
      absolute: true,
      ignore,
    });
    files.push(...matches);
  }

  return [...new Set(files)].sort();
}
