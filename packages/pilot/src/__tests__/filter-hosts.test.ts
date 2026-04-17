import { describe, it, expect } from 'vitest';
import {
  hostOf, hostMatchesAny, hostBlockedByAny, filterEntriesByHosts,
} from '../trace/filter-hosts.js';

describe('hostOf', () => {
  it('extracts the hostname from a URL', () => {
    expect(hostOf('https://api.example.com/users/1')).toBe('api.example.com');
    expect(hostOf('http://192.168.1.5:8080/path')).toBe('192.168.1.5');
  });

  it('lowercases the hostname', () => {
    expect(hostOf('https://API.Example.COM/')).toBe('api.example.com');
  });

  it('returns null for unparseable URLs', () => {
    expect(hostOf('')).toBeNull();
    expect(hostOf('not a url')).toBeNull();
  });
});

describe('hostMatchesAny', () => {
  it('returns true when the pattern list is empty (allow-all)', () => {
    expect(hostMatchesAny('api.example.com', [])).toBe(true);
    expect(hostMatchesAny('api.example.com', undefined)).toBe(true);
  });

  it('matches an exact hostname', () => {
    expect(hostMatchesAny('api.example.com', ['api.example.com'])).toBe(true);
    expect(hostMatchesAny('api.example.com', ['cdn.example.com'])).toBe(false);
  });

  it('matches a `*.example.com` glob against subdomains and the apex', () => {
    const patterns = ['*.example.com'];
    expect(hostMatchesAny('api.example.com', patterns)).toBe(true);
    expect(hostMatchesAny('cdn.images.example.com', patterns)).toBe(true);
    expect(hostMatchesAny('example.com', patterns)).toBe(true);
    expect(hostMatchesAny('example.org', patterns)).toBe(false);
  });

  it('matches `**.example.com` the same as `*.example.com`', () => {
    const patterns = ['**.example.com'];
    expect(hostMatchesAny('api.example.com', patterns)).toBe(true);
    expect(hostMatchesAny('example.com', patterns)).toBe(true);
    expect(hostMatchesAny('example.org', patterns)).toBe(false);
  });

  it('matches a trailing wildcard like `example.*`', () => {
    const patterns = ['example.*'];
    expect(hostMatchesAny('example.com', patterns)).toBe(true);
    expect(hostMatchesAny('example.co.uk', patterns)).toBe(true);
    expect(hostMatchesAny('api.example.com', patterns)).toBe(false);
  });

  it('matches IPv4 prefix globs', () => {
    expect(hostMatchesAny('192.168.1.5', ['192.168.1.*'])).toBe(true);
    expect(hostMatchesAny('192.168.2.5', ['192.168.1.*'])).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(hostMatchesAny('API.Example.COM', ['*.example.com'])).toBe(true);
  });

  it('matches if at least one pattern in a multi-pattern list hits', () => {
    const patterns = ['*.myapp.com', 'api.example.com'];
    expect(hostMatchesAny('api.myapp.com', patterns)).toBe(true);
    expect(hostMatchesAny('api.example.com', patterns)).toBe(true);
    expect(hostMatchesAny('www.apple.com', patterns)).toBe(false);
  });
});

describe('filterEntriesByHosts', () => {
  const entries = [
    { url: 'https://api.myapp.com/users' },
    { url: 'https://cdn.myapp.com/image.png' },
    { url: 'https://captive.apple.com/' },
    { url: 'https://clients4.google.com/chrome-variations/seed' },
    { url: 'not a url' },
  ];

  it('returns a copy of all entries when the pattern list is empty', () => {
    expect(filterEntriesByHosts(entries, undefined)).toEqual(entries);
    expect(filterEntriesByHosts(entries, [])).toEqual(entries);
  });

  it('keeps entries that match the allowlist and drops the rest', () => {
    const result = filterEntriesByHosts(entries, ['*.myapp.com']);
    expect(result.map((e) => e.url)).toEqual([
      'https://api.myapp.com/users',
      'https://cdn.myapp.com/image.png',
    ]);
  });

  it('drops unparseable URLs when filtering is active', () => {
    // `not a url` has no parseable host, so it should never match.
    const result = filterEntriesByHosts(entries, ['*.myapp.com']);
    expect(result.some((e) => e.url === 'not a url')).toBe(false);
  });

  it('combines multiple allowed patterns', () => {
    const result = filterEntriesByHosts(entries, ['*.myapp.com', '*.google.com']);
    expect(result.map((e) => e.url)).toEqual([
      'https://api.myapp.com/users',
      'https://cdn.myapp.com/image.png',
      'https://clients4.google.com/chrome-variations/seed',
    ]);
  });

  it('is a no-op when the allowlist matches nothing (empty result)', () => {
    const result = filterEntriesByHosts(entries, ['*.nonexistent.example']);
    expect(result).toEqual([]);
  });
});

describe('hostBlockedByAny', () => {
  it('returns false for empty/undefined deny list', () => {
    expect(hostBlockedByAny('api.myapp.com', undefined)).toBe(false);
    expect(hostBlockedByAny('api.myapp.com', [])).toBe(false);
  });

  it('returns true when any deny pattern matches', () => {
    expect(hostBlockedByAny('connectivitycheck.gstatic.com', ['connectivitycheck.gstatic.com'])).toBe(true);
    expect(hostBlockedByAny('play.googleapis.com', ['*.googleapis.com'])).toBe(true);
  });

  it('returns false when no deny pattern matches', () => {
    expect(hostBlockedByAny('api.myapp.com', ['*.googleapis.com', 'connectivitycheck.gstatic.com'])).toBe(false);
  });
});

describe('filterEntriesByHosts (allow + deny)', () => {
  const entries = [
    { url: 'https://api.myapp.com/users' },
    { url: 'https://cdn.myapp.com/image.png' },
    { url: 'https://connectivitycheck.gstatic.com/generate_204' },
    { url: 'https://play.googleapis.com/play/log' },
    { url: 'https://tracker.otherapp.com/beacon' },
  ];

  it('denylist-only: drops matching entries, keeps the rest', () => {
    const result = filterEntriesByHosts(entries, {
      deny: ['*.googleapis.com', 'connectivitycheck.gstatic.com'],
    });
    expect(result.map((e) => e.url)).toEqual([
      'https://api.myapp.com/users',
      'https://cdn.myapp.com/image.png',
      'https://tracker.otherapp.com/beacon',
    ]);
  });

  it('allowlist + denylist: both apply, deny wins over allow', () => {
    // allow: any *.myapp.com OR *.googleapis.com, but deny *.googleapis.com
    const result = filterEntriesByHosts(entries, {
      allow: ['*.myapp.com', '*.googleapis.com'],
      deny: ['*.googleapis.com'],
    });
    expect(result.map((e) => e.url)).toEqual([
      'https://api.myapp.com/users',
      'https://cdn.myapp.com/image.png',
    ]);
  });

  it('empty allow + empty deny is a no-op', () => {
    const result = filterEntriesByHosts(entries, { allow: [], deny: [] });
    expect(result).toEqual(entries);
  });

  it('undefined allow + undefined deny is a no-op', () => {
    expect(filterEntriesByHosts(entries, {})).toEqual(entries);
    expect(filterEntriesByHosts(entries, undefined)).toEqual(entries);
  });

  it('accepts legacy positional array as allowlist (back-compat)', () => {
    // The runner still calls filterEntriesByHosts(entries, stringArray).
    const result = filterEntriesByHosts(entries, ['*.myapp.com']);
    expect(result.map((e) => e.url)).toEqual([
      'https://api.myapp.com/users',
      'https://cdn.myapp.com/image.png',
    ]);
  });

  it('drops unparseable URLs only when a filter is active', () => {
    const withBad = [...entries, { url: 'not-a-url' }, { url: '' }];
    // No filters → all kept (including unparseable)
    expect(filterEntriesByHosts(withBad, {})).toHaveLength(withBad.length);
    // Deny-only → unparseable dropped
    const denyResult = filterEntriesByHosts(withBad, { deny: ['foo.bar'] });
    expect(denyResult.every((e) => e.url.startsWith('https://'))).toBe(true);
  });
});
