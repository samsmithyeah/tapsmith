import { describe, it, expect } from 'vitest';
import type { HierarchyNode } from '../trace-viewer/components/hierarchy-utils.js';
import { parseSelectorString, findMatchingNodes } from '../trace-viewer/components/selector-matching.js';
import { _role, _text, _textContains, _label } from '../selectors.js';

// PILOT-510: text and name matching normalize whitespace like Playwright —
// runs of whitespace (JavaScript's \s, so NBSP and line breaks too) collapse
// to one space and the ends are trimmed, on both sides. The agents do this on
// device; the trace-viewer/UI-mode playground must agree with them.

function node(tagName: string, attrs: Record<string, string>, children: HierarchyNode[] = []): HierarchyNode {
  return { tagName, attributes: new Map(Object.entries(attrs)), children, depth: 0 };
}

function count(roots: HierarchyNode[], code: string): number {
  const parsed = parseSelectorString(code);
  if (!parsed) throw new Error(`unparsed: ${code}`);
  return findMatchingNodes(roots, parsed).length;
}

describe('playground text matching normalizes whitespace (PILOT-510)', () => {
  const androidRoots = [
    node('android.widget.FrameLayout', { class: 'android.widget.FrameLayout', bounds: '[0,0][1080,2400]' }, [
      node('android.widget.TextView', {
        class: 'android.widget.TextView', text: 'Welcome to Expo', bounds: '[0,100][1080,200]',
      }),
      node('android.widget.TextView', {
        class: 'android.widget.TextView', text: 'Line one\nLine two', bounds: '[0,300][1080,400]',
      }),
      node('android.widget.Button', {
        class: 'android.widget.Button', 'content-desc': 'Save draft', bounds: '[0,500][1080,600]',
      }),
      node('android.widget.EditText', {
        class: 'android.widget.EditText', 'content-desc': 'Full name', bounds: '[0,700][1080,800]',
      }),
    ]),
  ];
  const iosRoots = [
    node('XCUIElementTypeOther', { type: 'XCUIElementTypeOther', x: '0', y: '0', width: '390', height: '844' }, [
      node('XCUIElementTypeStaticText', {
        type: 'XCUIElementTypeStaticText', label: 'Welcome to Expo', x: '0', y: '100', width: '390', height: '40',
      }),
    ]),
  ];

  it('exact getByText matches an NBSP label typed with a plain space', () => {
    expect(count(androidRoots, 'device.getByText("Welcome to Expo", { exact: true })')).toBe(1);
    expect(count(iosRoots, 'device.getByText("Welcome to Expo", { exact: true })')).toBe(1);
  });

  it('substring getByText matches across NBSP and line breaks', () => {
    expect(count(androidRoots, 'device.getByText("to Expo")')).toBe(1);
    expect(count(androidRoots, 'device.getByText("one Line")')).toBe(1);
    expect(count(iosRoots, 'device.getByText("to Expo")')).toBe(1);
  });

  it('collapses runs and trims the query too', () => {
    expect(count(androidRoots, 'device.getByText("  Line one   Line two ", { exact: true })')).toBe(1);
    expect(count(androidRoots, 'device.getByText("Welcome  to Expo")')).toBe(1);
  });

  it('still requires the whole text for exact', () => {
    expect(count(androidRoots, 'device.getByText("Welcome to", { exact: true })')).toBe(0);
    expect(count(androidRoots, 'device.getByText("WelcometoExpo", { exact: true })')).toBe(0);
  });

  it('getByRole name and getByLabel normalize too', () => {
    expect(count(androidRoots, 'device.getByRole("button", { name: "Save draft" })')).toBe(1);
    expect(count(androidRoots, 'device.getByLabel("Full name")')).toBe(1);
  });
});

describe('getBy* text arguments must be strings (PILOT-510)', () => {
  // getByText is typed `string`, but a test run through tsx is not
  // type-checked: a RegExp used to serialize as its source text and silently
  // never match. Fail loudly instead.
  it('rejects a RegExp passed as text', () => {
    expect(() => _textContains(/Welcome to\sExpo/ as unknown as string)).toThrow(
      /getByText\(\) expects a string, got a RegExp/,
    );
    expect(() => _text(/x/ as unknown as string)).toThrow(/getByText\(\) expects a string/);
  });

  it('rejects a non-string role name and label', () => {
    expect(() => _role('button', { name: /Save/ as unknown as string })).toThrow(
      /getByRole\(\) option `name` expects a string, got a RegExp/,
    );
    expect(() => _label(42 as unknown as string)).toThrow(/getByLabel\(\) expects a string, got a number/);
  });

  it('accepts strings, including an omitted role name', () => {
    expect(() => _textContains('Welcome')).not.toThrow();
    expect(() => _role('button')).not.toThrow();
    expect(() => _role('button', { name: 'Save' })).not.toThrow();
  });
});
