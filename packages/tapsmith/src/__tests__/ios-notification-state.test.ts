import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import bplistCreator from 'bplist-creator';
import * as plist from 'plist';
import {
  needsNotificationReset,
  parseNotificationAuthorizationStatus,
  type NotificationAuthorizationStatus,
} from '../ios-notification-state.js';
import type { NotificationPermissionState } from '../config.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

// Real VersionedSectionInfo.plist captured from a simulator where
// com.samlovesit.StoryApp had denied notifications (the PILOT-290 incident)
// and com.apple.MobileSMS was authorized.
const xmlFixture = fs.readFileSync(path.join(fixturesDir, 'versioned-section-info.plist'));
const binaryFixture = fs.readFileSync(
  path.join(fixturesDir, 'versioned-section-info-binary.plist'),
);

describe('parseNotificationAuthorizationStatus', () => {
  it('reads a denied app from an XML plist', () => {
    expect(parseNotificationAuthorizationStatus(xmlFixture, 'com.samlovesit.StoryApp'))
      .toBe('denied');
  });

  it('reads an authorized app from an XML plist', () => {
    expect(parseNotificationAuthorizationStatus(xmlFixture, 'com.apple.MobileSMS'))
      .toBe('authorized');
  });

  it('reads the same values from a binary plist', () => {
    expect(parseNotificationAuthorizationStatus(binaryFixture, 'com.samlovesit.StoryApp'))
      .toBe('denied');
    expect(parseNotificationAuthorizationStatus(binaryFixture, 'com.apple.MobileSMS'))
      .toBe('authorized');
  });

  it('reports notDetermined for a bundle id with no recorded section', () => {
    expect(parseNotificationAuthorizationStatus(xmlFixture, 'com.example.never-asked'))
      .toBe('notDetermined');
  });

  it('reports unknown for content that is not a BulletinBoard store', () => {
    expect(parseNotificationAuthorizationStatus(Buffer.from('<plist version="1.0"><dict/></plist>'), 'com.example.app'))
      .toBe('unknown');
  });

  // Apps with notification subsections archive one BBSectionInfoSettings per
  // subsection, and $objects ordering does not promise the app-level one is
  // first. Reading positionally could report a subsection's state as the
  // app's, skipping a required reset.
  describe('archives carrying several authorizationStatus values', () => {
    const archiveWith = (...statuses: number[]): Buffer => bplistCreator({
      $version: 100000,
      $archiver: 'NSKeyedArchiver',
      $top: { root: 1 },
      $objects: ['$null', ...statuses.map((s) => ({ authorizationStatus: s }))],
    });
    const storeWith = (bundleId: string, archive: Buffer): Buffer =>
      Buffer.from(plist.build({ sectionInfo: { [bundleId]: archive } }));

    it('answers when every archived status agrees', () => {
      // 2 (authorized) and 3 (provisional) are both grants — unambiguous.
      expect(parseNotificationAuthorizationStatus(
        storeWith('com.example.app', archiveWith(2, 3)), 'com.example.app',
      )).toBe('authorized');
    });

    it('reports unknown when archived statuses disagree', () => {
      // Untrusted rather than positional: callers reset on 'unknown', which
      // is conservative and loud instead of silently adopting the wrong one.
      expect(parseNotificationAuthorizationStatus(
        storeWith('com.example.app', archiveWith(2, 1)), 'com.example.app',
      )).toBe('unknown');
    });

    it('still reads a single-status archive positionally-independently', () => {
      expect(parseNotificationAuthorizationStatus(
        storeWith('com.example.app', archiveWith(1)), 'com.example.app',
      )).toBe('denied');
    });
  });
});

describe('needsNotificationReset', () => {
  const cases: Array<[NotificationAuthorizationStatus, NotificationPermissionState, boolean]> = [
    // granted: only a recorded denial blocks the target — notDetermined is
    // resolved by the agent accepting the prompt.
    ['notDetermined', 'granted', false],
    ['authorized', 'granted', false],
    ['denied', 'granted', true],
    ['unknown', 'granted', true],
    // denied: symmetric.
    ['notDetermined', 'denied', false],
    ['denied', 'denied', false],
    ['authorized', 'denied', true],
    ['unknown', 'denied', true],
    // prompt: any recorded decision must be cleared.
    ['notDetermined', 'prompt', false],
    ['authorized', 'prompt', true],
    ['denied', 'prompt', true],
    ['unknown', 'prompt', true],
  ];

  it.each(cases)('status %s with target %s → reset=%s', (status, target, expected) => {
    expect(needsNotificationReset(status, target)).toBe(expected);
  });

  it('rejects an invalid target state with a clear error', () => {
    expect(() => needsNotificationReset('notDetermined', 'maybe' as NotificationPermissionState))
      .toThrow(/permissions\.notifications/);
  });
});
