import { describe, it, expect } from 'vitest';
import { boundDetailLines, labelledMessage, splitHeadline, withDetail } from '../error-detail.js';

// How a start error keeps its detail: a one-line headline, then the rest
// bounded and indented under it (PILOT-463, PILOT-464).

describe('withDetail()', () => {
  it('indents each detail line under the headline', () => {
    expect(withDetail('Failed to start', ['cause', 'Daemon log: /tmp/d.log'])).toBe(
      'Failed to start\n  cause\n  Daemon log: /tmp/d.log',
    );
  });

  it('is the headline alone when there is no detail', () => {
    expect(withDetail('Failed to start', [])).toBe('Failed to start');
  });

  it('keeps nested indentation, so a detail with its own detail nests', () => {
    const inner = withDetail('Worker 1 (sim): build failed', ['error: x']);
    expect(withDetail('No worker could start', inner.split('\n'))).toBe(
      'No worker could start\n  Worker 1 (sim): build failed\n    error: x',
    );
  });

  it('drops blank lines at the ends, not in the middle', () => {
    expect(withDetail('H', ['', 'a', '', 'b', ''])).toBe('H\n  a\n\n  b');
  });
});

describe('labelledMessage()', () => {
  it('puts the label before the first line and indents the rest', () => {
    expect(labelledMessage('ios: ', 'iOS simulator agent build failed (exit 65)\nerror: no signing\nLog: /tmp/build.log'))
      .toBe('ios: iOS simulator agent build failed (exit 65)\n  error: no signing\n  Log: /tmp/build.log');
  });

  it('leaves a one-line message alone', () => {
    expect(labelledMessage('ios: ', 'boom')).toBe('ios: boom');
  });

  it('re-indents a message that already indents its detail, one level deeper', () => {
    const message = labelledMessage('Worker 1: ', 'build failed\nerror: x');
    expect(labelledMessage('ios: ', message)).toBe('ios: Worker 1: build failed\n    error: x');
  });
});

describe('boundDetailLines()', () => {
  it('keeps short details whole', () => {
    expect(boundDetailLines(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('keeps the head and the tail of a long detail, saying how much it left out', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    const bounded = boundDetailLines(lines);
    expect(bounded.length).toBeLessThanOrEqual(40);
    expect(bounded[0]).toBe('line 1');
    // The tail is where the log path is.
    expect(bounded[bounded.length - 1]).toBe('line 100');
    const marker = bounded.find((l) => l.startsWith('…'));
    expect(marker).toMatch(/^… \(\d+ more lines\)$/);
    const omitted = Number(/\((\d+) more/.exec(marker!)![1]);
    expect(bounded.length - 1 + omitted).toBe(100);
  });

  it('caps a runaway line', () => {
    const [line] = boundDetailLines(['x'.repeat(5000)]);
    expect(line.length).toBeLessThanOrEqual(1001);
    expect(line.endsWith('…')).toBe(true);
  });
});

describe('splitHeadline()', () => {
  it('keeps the detail\'s own indentation, dropping only blank edge lines', () => {
    expect(splitHeadline('Failed to start: exited\n  Recent daemon output:\n    Error: x\n')).toEqual({
      headline: 'Failed to start: exited',
      detail: '  Recent daemon output:\n    Error: x',
    });
  });

  it('has no detail for a one-line message', () => {
    expect(splitHeadline('boom')).toEqual({ headline: 'boom', detail: '' });
  });
});
