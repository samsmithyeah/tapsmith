import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
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
