import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import { findAgentApk, findAgentTestApk } from '../agent-resolve.js';

vi.mock('node:fs');

const existsSync = vi.mocked(fs.existsSync);

beforeEach(() => {
  existsSync.mockReset();
});

describe('findAgentApk()', () => {
  it('returns bundled path when it exists', () => {
    existsSync.mockImplementation((p) =>
      String(p).includes('agents/android/app-debug.apk'),
    );

    const result = findAgentApk();
    expect(result).toBeDefined();
    expect(result).toContain('agents/android/app-debug.apk');
  });

  it('falls back to monorepo path when bundled not found', () => {
    let callIndex = 0;
    existsSync.mockImplementation(() => {
      callIndex++;
      // First call is bundled (miss), second is first monorepo candidate (hit)
      return callIndex === 2;
    });

    const result = findAgentApk();
    expect(result).toBeDefined();
    expect(result).toContain('agent/app/build/outputs/apk/debug/app-debug.apk');
  });

  it('returns undefined when no path exists', () => {
    existsSync.mockReturnValue(false);
    expect(findAgentApk()).toBeUndefined();
  });
});

describe('findAgentTestApk()', () => {
  it('returns bundled path when it exists', () => {
    existsSync.mockImplementation((p) =>
      String(p).includes('agents/android/app-debug-androidTest.apk'),
    );

    const result = findAgentTestApk();
    expect(result).toBeDefined();
    expect(result).toContain('agents/android/app-debug-androidTest.apk');
  });

  it('returns undefined when no path exists', () => {
    existsSync.mockReturnValue(false);
    expect(findAgentTestApk()).toBeUndefined();
  });
});
