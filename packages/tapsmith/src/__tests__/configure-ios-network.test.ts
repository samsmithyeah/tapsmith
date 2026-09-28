import { describe, expect, it } from 'vitest';
import { walkthroughLines } from '../configure-ios-network.js';

const plain = (lines: string[]): string => lines.join('\n').replace(/\x1b\[[0-9;]*m/g, '');

const result = { profilePath: '/p/U1.mobileconfig', hostIp: '192.168.1.42', port: 9123, ssid: 'Home' };

describe('tapsmith ios network configure walkthrough (PILOT-271)', () => {
  it('walks a first install through send, install, trust, proxy URL and verify', () => {
    const text = plain(walkthroughLines({ udid: 'U1', refresh: false }, result));
    expect(text).toContain('To install on the device:');
    expect(text).toContain('Certificate Trust Settings');
    expect(text).toContain('http://192.168.1.42:9123/tapsmith.pac');
    expect(text).toContain('tapsmith ios network verify U1');
    expect(text).toContain('tapsmith ios network configure U1 --refresh');
    expect(text).not.toContain('remove the existing');
  });

  it('--refresh removes the old profile first, then prints the new proxy URL (PILOT-255)', () => {
    const text = plain(walkthroughLines({ udid: 'U1', refresh: true }, result));
    expect(text).toContain('To apply the refreshed profile:');
    expect(text).toMatch(/remove the existing "Tapsmith Network Capture" profile/);
    // A host-IP change is the reason to refresh, and the PAC URL is typed into
    // the device's Wi-Fi settings by hand, so the walkthrough must print it.
    expect(text).toContain('http://192.168.1.42:9123/tapsmith.pac');
    expect(text).toMatch(/Configure Proxy/);
    expect(text).toContain('Certificate Trust Settings');
    expect(text).toContain('tapsmith ios network verify U1');
    expect(text.indexOf('remove the existing')).toBeLessThan(text.indexOf('tapsmith.pac'));
  });

  it('never names the removed commands', () => {
    for (const refresh of [false, true]) {
      const text = plain(walkthroughLines({ udid: 'U1', refresh }, result));
      expect(text).not.toMatch(/refresh-ios-network|verify-ios-network|configure-ios-network/);
    }
  });
});
