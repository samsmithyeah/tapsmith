import { describe, it, expect, beforeEach } from 'vitest';
import { classifyDevicectlError, clearTrustProbeCache, isSuccessfulLaunch } from '../ios-trust-probe.js';

describe('isSuccessfulLaunch', () => {
  it('recognises the devicectl success line observed on Xcode 26', () => {
    const real = [
      'Acquired tunnel connection to device.',
      'Enabling developer disk image services.',
      'Acquired usage assertion.',
      'Launched application with dev.pilot.agent.xctrunner bundle identifier.',
    ].join('\n');
    expect(isSuccessfulLaunch(real)).toBe(true);
  });

  it('returns false for error-only output', () => {
    expect(isSuccessfulLaunch('Error: No such app on device')).toBe(false);
    expect(isSuccessfulLaunch('')).toBe(false);
  });

  it('ignores unrelated noise in the same output', () => {
    // devicectl sometimes emits a harmless `Failed to load provisioning parameter list`
    // alongside a successful launch — the success line must still win.
    const noisy = [
      'Launched application with dev.pilot.agent.xctrunner bundle identifier.',
      'Failed to load provisioning paramter list due to error: ...',
    ].join('\n');
    expect(isSuccessfulLaunch(noisy)).toBe(true);
  });
});

describe('classifyDevicectlError', () => {
  beforeEach(() => {
    clearTrustProbeCache();
  });

  it('classifies untrusted developer certificate failures', () => {
    const samples = [
      'The application could not be launched because the Developer App Certificate is not trusted.',
      'Unable to launch dev.pilot.agent.xctrunner: untrusted developer',
      'Error: UntrustedDeveloper — please verify the developer in Settings',
      'The application could not be verified.',
    ];
    for (const s of samples) {
      expect(classifyDevicectlError(s)).toBe('untrusted');
    }
  });

  it('classifies runner-not-installed failures', () => {
    const samples = [
      'Error: No such app on device: dev.pilot.agent.xctrunner',
      'Application not found',
      'Application bundle for com.example was not found',
    ];
    for (const s of samples) {
      expect(classifyDevicectlError(s)).toBe('runner-not-installed');
    }
  });

  it('falls back to unknown on ambiguous errors rather than lying', () => {
    const samples = [
      'Developer Mode disabled',
      'Device is locked. Unlock and retry.',
      'Some other devicectl error we have not seen before',
      '',
    ];
    for (const s of samples) {
      expect(classifyDevicectlError(s)).toBe('unknown');
    }
  });
});
