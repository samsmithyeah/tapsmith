import { describe, it, expect } from 'vitest';
import {
  role,
  text,
  textContains,
  contentDesc,
  hint,
  className,
  testId,
  id,
  xpath,
  selectorToProto,
  type Selector,
} from '../selectors.js';

// ─── Selector builder functions ───

describe('selector builders', () => {
  it('role() creates a role selector with role and name', () => {
    const sel = role('button', 'Submit');
    expect(sel.kind).toEqual({ type: 'role', value: { role: 'button', name: 'Submit' } });
    expect(sel.parent).toBeUndefined();
  });

  it('role() defaults name to empty string when omitted', () => {
    const sel = role('checkbox');
    expect(sel.kind).toEqual({ type: 'role', value: { role: 'checkbox', name: '' } });
  });

  it('text() creates a text selector', () => {
    const sel = text('Hello World');
    expect(sel.kind).toEqual({ type: 'text', value: 'Hello World' });
  });

  it('textContains() creates a textContains selector', () => {
    const sel = textContains('partial');
    expect(sel.kind).toEqual({ type: 'textContains', value: 'partial' });
  });

  it('contentDesc() creates a contentDesc selector', () => {
    const sel = contentDesc('Close button');
    expect(sel.kind).toEqual({ type: 'contentDesc', value: 'Close button' });
  });

  it('hint() creates a hint selector', () => {
    const sel = hint('Enter email');
    expect(sel.kind).toEqual({ type: 'hint', value: 'Enter email' });
  });

  it('className() creates a className selector', () => {
    const sel = className('android.widget.Button');
    expect(sel.kind).toEqual({ type: 'className', value: 'android.widget.Button' });
  });

  it('testId() creates a testId selector', () => {
    const sel = testId('submit-btn');
    expect(sel.kind).toEqual({ type: 'testId', value: 'submit-btn' });
  });

  it('id() creates an id selector', () => {
    const sel = id('com.app:id/btn_submit');
    expect(sel.kind).toEqual({ type: 'id', value: 'com.app:id/btn_submit' });
  });

  it('xpath() creates an xpath selector', () => {
    const sel = xpath('//android.widget.Button[@text="OK"]');
    expect(sel.kind).toEqual({ type: 'xpath', value: '//android.widget.Button[@text="OK"]' });
  });

  it('all selectors start with no parent', () => {
    const selectors = [
      role('button'),
      text('hi'),
      textContains('hi'),
      contentDesc('hi'),
      hint('hi'),
      className('X'),
      testId('x'),
      id('x'),
      xpath('//x'),
    ];
    for (const sel of selectors) {
      expect(sel.parent).toBeUndefined();
    }
  });
});

// ─── .within() chaining ───

describe('within() chaining', () => {
  it('sets the parent on the new selector', () => {
    const parent = role('list');
    const child = text('Item 1').within(parent);
    expect(child.parent).toBeDefined();
    expect(child.parent!.kind).toEqual(parent.kind);
  });

  it('does not mutate the original selector', () => {
    const parent = role('list');
    const original = text('Item 1');
    const scoped = original.within(parent);
    expect(original.parent).toBeUndefined();
    expect(scoped.parent).toBeDefined();
  });

  it('preserves the child kind when chaining', () => {
    const parent = className('android.widget.ListView');
    const child = testId('row-3').within(parent);
    expect(child.kind).toEqual({ type: 'testId', value: 'row-3' });
  });

  it('supports multi-level nesting', () => {
    const grandparent = role('navigation');
    const parent = className('MenuList').within(grandparent);
    const child = text('Settings').within(parent);

    expect(child.parent).toBeDefined();
    expect(child.parent!.parent).toBeDefined();
    expect(child.parent!.parent!.kind.type).toBe('role');
  });
});

// ─── selectorToProto() ───

describe('selectorToProto()', () => {
  it('serializes role selector', () => {
    const proto = selectorToProto(role('button', 'OK'));
    expect(proto).toEqual({ role: { role: 'button', name: 'OK' } });
  });

  it('serializes text selector', () => {
    expect(selectorToProto(text('Hello'))).toEqual({ text: 'Hello' });
  });

  it('serializes textContains selector', () => {
    expect(selectorToProto(textContains('ell'))).toEqual({ textContains: 'ell' });
  });

  it('serializes contentDesc selector', () => {
    expect(selectorToProto(contentDesc('Back'))).toEqual({ contentDesc: 'Back' });
  });

  it('serializes hint selector', () => {
    expect(selectorToProto(hint('Search'))).toEqual({ hint: 'Search' });
  });

  it('serializes className selector', () => {
    expect(selectorToProto(className('android.widget.EditText'))).toEqual({
      className: 'android.widget.EditText',
    });
  });

  it('serializes testId selector', () => {
    expect(selectorToProto(testId('my-id'))).toEqual({ testId: 'my-id' });
  });

  it('serializes id selector as resourceId', () => {
    expect(selectorToProto(id('com.app:id/foo'))).toEqual({ resourceId: 'com.app:id/foo' });
  });

  it('serializes xpath selector', () => {
    expect(selectorToProto(xpath('//Button'))).toEqual({ xpath: '//Button' });
  });

  it('serializes nested parent selectors', () => {
    const parent = role('list');
    const child = text('Item').within(parent);
    const proto = selectorToProto(child);
    expect(proto).toEqual({
      text: 'Item',
      parent: { role: { role: 'list', name: '' } },
    });
  });

  it('serializes deeply nested selectors', () => {
    const grandparent = id('root');
    const parent = className('Container').within(grandparent);
    const child = text('Label').within(parent);
    const proto = selectorToProto(child);
    expect(proto).toEqual({
      text: 'Label',
      parent: {
        className: 'Container',
        parent: {
          resourceId: 'root',
        },
      },
    });
  });

  it('handles empty string values', () => {
    expect(selectorToProto(text(''))).toEqual({ text: '' });
  });
});
