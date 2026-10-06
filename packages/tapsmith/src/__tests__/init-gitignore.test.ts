import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ignoreTestResults } from '../init-gitignore.js';

const tmps: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapsmith-gitignore-'));
  tmps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const notIgnored = (): boolean => false;
const read = (dir: string): string => fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');

describe('ignoreTestResults() (PILOT-562)', () => {
  it('creates a .gitignore ignoring tapsmith-results/ when there is none', () => {
    const dir = tmp();
    expect(ignoreTestResults(dir, notIgnored)).toBe('created');
    expect(read(dir)).toBe('# Tapsmith test results (traces, screenshots, reports)\ntapsmith-results/\n');
  });

  it('appends to an existing .gitignore, keeping what is there, after a missing final newline', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.expo');
    expect(ignoreTestResults(dir, notIgnored)).toBe('added');
    expect(read(dir)).toBe('node_modules/\n.expo\n\n# Tapsmith test results (traces, screenshots, reports)\ntapsmith-results/\n');
  });

  it('is idempotent: a second run changes nothing', () => {
    const dir = tmp();
    ignoreTestResults(dir, notIgnored);
    const once = read(dir);
    expect(ignoreTestResults(dir, notIgnored)).toBe('present');
    expect(read(dir)).toBe(once);
  });

  it.each(['tapsmith-results', '/tapsmith-results/', '  tapsmith-results/  ', 'tapsmith-results/**'])(
    'leaves a .gitignore that already lists %j alone',
    (line) => {
      const dir = tmp();
      fs.writeFileSync(path.join(dir, '.gitignore'), `node_modules/\n${line}\n`);
      expect(ignoreTestResults(dir, notIgnored)).toBe('present');
      expect(read(dir)).toBe(`node_modules/\n${line}\n`);
    },
  );

  it('changes nothing when git already ignores it (a parent .gitignore, say)', () => {
    const dir = tmp();
    expect(ignoreTestResults(dir, () => true)).toBe('present');
    expect(fs.existsSync(path.join(dir, '.gitignore'))).toBe(false);
  });

  it('asks git, by default, whether a repository .gitignore above the project already covers it', () => {
    if (spawnSync('git', ['--version']).status !== 0) return; // no git on this machine
    const repo = tmp();
    spawnSync('git', ['init', '-q'], { cwd: repo });
    fs.writeFileSync(path.join(repo, '.gitignore'), 'tapsmith-results/\n');
    const project = path.join(repo, 'apps', 'mobile');
    fs.mkdirSync(project, { recursive: true });
    expect(ignoreTestResults(project)).toBe('present');
    expect(fs.existsSync(path.join(project, '.gitignore'))).toBe(false);

    // Not covered by the repository's ignores: the project's own .gitignore gets the entry.
    fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
    expect(ignoreTestResults(project)).toBe('created');
  });

  it('throws when the .gitignore cannot be written, for the caller to report', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, '.gitignore')); // a directory where the file should be
    expect(() => ignoreTestResults(dir, notIgnored)).toThrow();
  });
});
