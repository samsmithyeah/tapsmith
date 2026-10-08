import { describe, it, expect } from 'vitest';
import { tsxIpcPathProblem } from '../child-scripts.js';

// tsx opens a Unix socket at <tmpdir>/tsx-<uid>/<pid>.pipe; a long $TMPDIR
// made `tapsmith test` crash with tsx's raw `listen EINVAL` (PILOT-569).
describe('tsxIpcPathProblem()', () => {
  const dirOfLength = (n: number): string => `/${'a'.repeat(n - 1)}`;

  it('accepts the default macOS temp directory', () => {
    expect(tsxIpcPathProblem({ tmpdir: '/var/folders/zz/zyxvpxvq6csfxvn_n0000000000000/T', platform: 'darwin', uid: 501 })).toBeUndefined();
  });

  it('names the socket path, the limit and the fix for a temp directory too long on macOS', () => {
    const tmpdir = dirOfLength(120);
    const problem = tsxIpcPathProblem({ tmpdir, platform: 'darwin', uid: 501 });
    expect(problem).toContain(`${tmpdir}/tsx-501/`);
    expect(problem).toContain('103');
    expect(problem).toContain('TMPDIR=/tmp');
  });

  it('allows the longest path that fits, and not one byte more', () => {
    // "/tsx-501/99999.pipe" is 19 bytes: a 84-byte tmpdir makes 103.
    expect(tsxIpcPathProblem({ tmpdir: dirOfLength(84), platform: 'darwin', uid: 501 })).toBeUndefined();
    expect(tsxIpcPathProblem({ tmpdir: dirOfLength(85), platform: 'darwin', uid: 501 })).toBeDefined();
  });

  it('uses Linux\'s larger limit and longer pids', () => {
    // "/tsx-1000/4194304.pipe" is 22 bytes: 85 + 22 = 107 fits; 86 does not.
    expect(tsxIpcPathProblem({ tmpdir: dirOfLength(85), platform: 'linux', uid: 1000 })).toBeUndefined();
    expect(tsxIpcPathProblem({ tmpdir: dirOfLength(86), platform: 'linux', uid: 1000 })).toBeDefined();
  });

  it('never objects on Windows, where tsx uses a named pipe', () => {
    expect(tsxIpcPathProblem({ tmpdir: dirOfLength(300), platform: 'win32', uid: 'me' })).toBeUndefined();
  });
});
