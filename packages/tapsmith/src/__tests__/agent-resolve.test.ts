import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

vi.mock('node:fs');

const { mockResolve } = vi.hoisted(() => ({
  mockResolve: vi.fn(),
}));

vi.mock('node:module', () => ({
  createRequire: () => ({ resolve: mockResolve }),
}));

import { findAgentApk, findAgentTestApk } from '../agent-resolve.js';

const existsSync = vi.mocked(fs.existsSync);

beforeEach(() => {
  existsSync.mockReset();
  mockResolve.mockReset();
});

describe('findAgentApk()', () => {
  it('returns npm package path when @tapsmith/agent-android is installed', () => {
    mockResolve.mockReturnValue('/node_modules/@tapsmith/agent-android/package.json');
    existsSync.mockImplementation((p) =>
      String(p) === path.resolve('/node_modules/@tapsmith/agent-android', 'app-debug.apk'),
    );

    const result = findAgentApk();
    expect(result).toContain('@tapsmith/agent-android');
    expect(result).toContain('app-debug.apk');
  });

  it('falls back to monorepo path when npm package not installed', () => {
    mockResolve.mockImplementation(() => { throw new Error('not found'); });
    let callIndex = 0;
    existsSync.mockImplementation(() => {
      callIndex++;
      return callIndex === 1; // first monorepo candidate
    });

    const result = findAgentApk();
    expect(result).toBeDefined();
    expect(result).toContain('agent/app/build/outputs/apk/debug/app-debug.apk');
  });

  it('returns undefined when no path exists', () => {
    mockResolve.mockImplementation(() => { throw new Error('not found'); });
    existsSync.mockReturnValue(false);
    expect(findAgentApk()).toBeUndefined();
  });
});

describe('findAgentTestApk()', () => {
  it('returns npm package path when @tapsmith/agent-android is installed', () => {
    mockResolve.mockReturnValue('/node_modules/@tapsmith/agent-android/package.json');
    existsSync.mockImplementation((p) =>
      String(p) === path.resolve('/node_modules/@tapsmith/agent-android', 'app-debug-androidTest.apk'),
    );

    const result = findAgentTestApk();
    expect(result).toContain('@tapsmith/agent-android');
    expect(result).toContain('app-debug-androidTest.apk');
  });

  it('returns undefined when no path exists', () => {
    mockResolve.mockImplementation(() => { throw new Error('not found'); });
    existsSync.mockReturnValue(false);
    expect(findAgentTestApk()).toBeUndefined();
  });
});
