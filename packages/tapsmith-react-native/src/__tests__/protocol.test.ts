import { describe, expect, it } from 'vitest';
import { formatMarker, parseMarker, parseResetRequest, routeOf } from '../protocol.js';

describe('marker', () => {
  it('round-trips, including an error message', () => {
    const text = formatMarker({ epoch: 4, urlPrefix: 'myapp:///' });
    expect(text).toBe('tapsmith-hooks:1;epoch=4;url=myapp:///');
    expect(parseMarker(text)).toEqual({ version: 1, epoch: 4, urlPrefix: 'myapp:///', error: undefined });

    const withErr = formatMarker({ epoch: 5, urlPrefix: 'exp://10.0.0.5:8081/--/', error: 'AsyncStorage failed: boom & "x"' });
    expect(withErr).not.toMatch(/["']/); // must be safe inside an XML attribute
    expect(parseMarker(withErr)).toMatchObject({ epoch: 5, urlPrefix: 'exp://10.0.0.5:8081/--/', error: 'AsyncStorage failed: boom & "x"' });
  });

  it('parses when embedded in surrounding text and rejects non-markers', () => {
    expect(parseMarker('label: tapsmith-hooks:1;epoch=2;url=a:///')?.epoch).toBe(2);
    expect(parseMarker('hello')).toBeUndefined();
    expect(parseMarker('tapsmith-hooks:1;url=a:///')).toBeUndefined();
  });
});

describe('reset requests', () => {
  it('recognises the flag and extracts target + nonce', () => {
    expect(parseResetRequest('myapp:///login?__tapsmith_reset=1&nonce=abc')).toEqual({ target: '/login', nonce: 'abc' });
    expect(parseResetRequest('myapp:///?__tapsmith_reset=1&nonce=n')).toEqual({ target: '/', nonce: 'n' });
    expect(parseResetRequest('exp://10.0.0.5:8081/--/settings?tab=2&__tapsmith_reset=1&nonce=z')).toEqual({ target: '/settings', nonce: 'z' });
    expect(parseResetRequest('myapp://login?__tapsmith_reset=1')).toEqual({ target: '/login', nonce: '' });
  });

  it('ignores ordinary deep links', () => {
    expect(parseResetRequest('myapp:///login')).toBeUndefined();
    expect(parseResetRequest('myapp:///login?tab=2')).toBeUndefined();
  });
});

describe('routeOf', () => {
  it('normalises the common URL shapes', () => {
    expect(routeOf('myapp:///')).toBe('/');
    expect(routeOf('myapp:///login')).toBe('/login');
    expect(routeOf('myapp://login')).toBe('/login');
    expect(routeOf('exp://10.0.0.5:8081/--/settings')).toBe('/settings');
    expect(routeOf('https://example.com/profile')).toBe('/profile');
    expect(routeOf('https://example.com')).toBe('/');
  });
});
