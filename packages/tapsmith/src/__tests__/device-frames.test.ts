import { describe, it, expect } from 'vitest';
import {
  actingDevice,
  deviceNamesFor,
  frameIndexForDevice,
  hierarchyForDeviceFrame,
  isMultiDevice,
  nextFrameIndexForDevice,
  screenshotForFrame,
  terminalFrameIndex,
  type DeviceGroupView,
} from '../trace-viewer/components/device-frames.js';
import type { ActionTraceEvent, AssertionTraceEvent } from '../trace/types.js';

// A two-user trace: alice taps (0), bob taps (1), alice asserts (2), bob
// asserts (3). Terminal screenshots land at actionCount (4) for alice and 5
// for bob, in group order.

function action(actionIndex: number, deviceId?: string): ActionTraceEvent {
  return {
    type: 'action', actionIndex, timestamp: actionIndex * 100, category: 'tap', action: 'tap',
    duration: 1, success: true, hasScreenshotBefore: true, hasScreenshotAfter: false,
    hasHierarchyBefore: true, hasHierarchyAfter: false, ...(deviceId ? { deviceId } : {}),
  };
}
function assertion(actionIndex: number, deviceId?: string): AssertionTraceEvent {
  return {
    type: 'assertion', actionIndex, timestamp: actionIndex * 100, assertion: 'toBeVisible', passed: true,
    soft: false, negated: false, duration: 1, attempts: 1, ...(deviceId ? { deviceId } : {}),
  };
}

const group: DeviceGroupView = {
  devices: [
    { name: 'alice', serial: 'A', isEmulator: true, platform: 'android' },
    { name: 'bob', serial: 'B', isEmulator: true, platform: 'android', devicePixelRatio: 2 },
  ],
  actionEvents: [action(0, 'alice'), action(1, 'bob'), assertion(2, 'alice'), assertion(3, 'bob')],
  actionCount: 4,
  hierarchies: new Map([
    ['hierarchy/action-001-before.xml', '<bob-1/>'],
    ['hierarchy/action-005-after.xml', '<bob-terminal/>'],
  ]),
};

describe('device-frames', () => {
  it('recognises a multi-device trace and attributes untagged events to the primary', () => {
    expect(isMultiDevice({ devices: group.devices })).toBe(true);
    expect(isMultiDevice({ devices: [group.devices[0]] })).toBe(false);
    expect(isMultiDevice(undefined)).toBe(false);
    expect(actingDevice(group, action(9))).toBe('alice');
    expect(actingDevice(group, action(9, 'bob'))).toBe('bob');
    expect(actingDevice(group, action(9, 'carol'))).toBe('alice');
  });

  it('places terminal screenshots after the action count, in group order', () => {
    expect(terminalFrameIndex(group, 'alice')).toBe(4);
    expect(terminalFrameIndex(group, 'bob')).toBe(5);
  });

  it('shows the acting device its own before-frame and its next capture as after', () => {
    expect(frameIndexForDevice(group, 'alice', 0, 'before')).toBe(0);
    expect(frameIndexForDevice(group, 'alice', 0, 'after')).toBe(2);
    expect(nextFrameIndexForDevice(group, 'alice', 2)).toBe(4);
    expect(frameIndexForDevice(group, 'bob', 3, 'after')).toBe(5);
  });

  it("shows the other device its latest capture at or before the step, and its next past it", () => {
    // Bob at alice's tap (0): nothing before → his next capture (1).
    expect(frameIndexForDevice(group, 'bob', 0, 'before')).toBe(1);
    expect(frameIndexForDevice(group, 'bob', 0, 'after')).toBe(1);
    // Bob at alice's assertion (2): his latest capture is 1; his state after is 3.
    expect(frameIndexForDevice(group, 'bob', 2, 'before')).toBe(1);
    expect(frameIndexForDevice(group, 'bob', 2, 'after')).toBe(3);
    // Alice at bob's assertion (3): latest 2; nothing follows → terminal 4.
    expect(frameIndexForDevice(group, 'alice', 3, 'before')).toBe(2);
    expect(frameIndexForDevice(group, 'alice', 3, 'after')).toBe(4);
  });

  it('resolves screenshots and hierarchies for a frame, preferring before-captures', () => {
    const shots = new Map([
      ['screenshots/action-001-before.png', 'blob:one'],
      ['screenshots/action-005-after.png', 'blob:five'],
    ]);
    expect(screenshotForFrame(shots, 1)).toBe('blob:one');
    expect(screenshotForFrame(shots, 5)).toBe('blob:five');
    expect(screenshotForFrame(shots, 2)).toBeUndefined();
    expect(hierarchyForDeviceFrame(group, 1)).toBe('<bob-1/>');
    expect(hierarchyForDeviceFrame(group, 5)).toBe('<bob-terminal/>');
    expect(hierarchyForDeviceFrame(group, 0)).toBeUndefined();
  });

  it('lists device names in group order, adding any the network entries introduce', () => {
    expect(deviceNamesFor({ devices: group.devices }, [{ deviceId: 'bob' }, { deviceId: 'carol' }, {}])).toEqual(['alice', 'bob', 'carol']);
    expect(deviceNamesFor(undefined, [{}])).toEqual([]);
  });
});
