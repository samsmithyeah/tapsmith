import { describe, it, expect } from 'vitest';
import {
  _role,
  _text,
  _textContains,
  _contentDesc,
  _hint,
  _className,
  _testId,
  _id,
  _xpath,
  withParent,
  selectorToProto,
} from '../selectors.js';

// ─── Internal selector builders ───

describe('internal selector builders', () => {
  it('_role() creates a role selector with role and name', () => {
    const sel = _role('button', 'Submit');
    expect(sel.kind).toEqual({ type: 'role', value: { role: 'button', name: 'Submit' } });
    expect(sel.parent).toBeUndefined();
  });

  it('_role() defaults name to empty string when omitted', () => {
    const sel = _role('checkbox');
    expect(sel.kind).toEqual({ type: 'role', value: { role: 'checkbox', name: '' } });
  });

  it('_text() creates a text selector', () => {
    expect(_text('Hello World').kind).toEqual({ type: 'text', value: 'Hello World' });
  });

  it('_textContains() creates a textContains selector', () => {
    expect(_textContains('partial').kind).toEqual({ type: 'textContains', value: 'partial' });
  });

  it('_contentDesc() creates a contentDesc selector', () => {
    expect(_contentDesc('Close button').kind).toEqual({ type: 'contentDesc', value: 'Close button' });
  });

  it('_hint() creates a hint selector', () => {
    expect(_hint('Enter email').kind).toEqual({ type: 'hint', value: 'Enter email' });
  });

  it('_className() creates a className selector', () => {
    expect(_className('android.widget.Button').kind).toEqual({
      type: 'className',
      value: 'android.widget.Button',
    });
  });

  it('_testId() creates a testId selector', () => {
    expect(_testId('submit-btn').kind).toEqual({ type: 'testId', value: 'submit-btn' });
  });

  it('_id() creates an id selector', () => {
    expect(_id('com.app:id/btn_submit').kind).toEqual({
      type: 'id',
      value: 'com.app:id/btn_submit',
    });
  });

  it('_xpath() creates an xpath selector', () => {
    expect(_xpath('//android.widget.Button[@text="OK"]').kind).toEqual({
      type: 'xpath',
      value: '//android.widget.Button[@text="OK"]',
    });
  });

  it('all selectors start with no parent', () => {
    const selectors = [
      _role('button'),
      _text('hi'),
      _textContains('hi'),
      _contentDesc('hi'),
      _hint('hi'),
      _className('X'),
      _testId('x'),
      _id('x'),
      _xpath('//x'),
    ];
    for (const sel of selectors) {
      expect(sel.parent).toBeUndefined();
    }
  });
});

// ─── withParent() ───

describe('withParent()', () => {
  it('sets the parent on the new selector', () => {
    const parent = _role('list');
    const child = withParent(_text('Item 1'), parent);
    expect(child.parent).toBeDefined();
    expect(child.parent!.kind).toEqual(parent.kind);
  });

  it('does not mutate the original selector', () => {
    const parent = _role('list');
    const original = _text('Item 1');
    const scoped = withParent(original, parent);
    expect(original.parent).toBeUndefined();
    expect(scoped.parent).toBeDefined();
  });

  it('preserves the child kind', () => {
    const parent = _className('android.widget.ListView');
    const child = withParent(_testId('row-3'), parent);
    expect(child.kind).toEqual({ type: 'testId', value: 'row-3' });
  });

  it('supports multi-level nesting', () => {
    const grandparent = _role('navigation');
    const parent = withParent(_className('MenuList'), grandparent);
    const child = withParent(_text('Settings'), parent);

    expect(child.parent).toBeDefined();
    expect(child.parent!.parent).toBeDefined();
    expect(child.parent!.parent!.kind.type).toBe('role');
  });
});

// ─── selectorToProto() ───

describe('selectorToProto()', () => {
  it('serializes role selector', () => {
    expect(selectorToProto(_role('button', 'OK'))).toEqual({ role: { role: 'button', name: 'OK' } });
  });

  it('serializes text selector', () => {
    expect(selectorToProto(_text('Hello'))).toEqual({ text: 'Hello' });
  });

  it('serializes textContains selector', () => {
    expect(selectorToProto(_textContains('ell'))).toEqual({ textContains: 'ell' });
  });

  it('serializes contentDesc selector', () => {
    expect(selectorToProto(_contentDesc('Back'))).toEqual({ contentDesc: 'Back' });
  });

  it('serializes hint selector', () => {
    expect(selectorToProto(_hint('Search'))).toEqual({ hint: 'Search' });
  });

  it('serializes className selector', () => {
    expect(selectorToProto(_className('android.widget.EditText'))).toEqual({
      className: 'android.widget.EditText',
    });
  });

  it('serializes testId selector', () => {
    expect(selectorToProto(_testId('my-id'))).toEqual({ testId: 'my-id' });
  });

  it('serializes id selector as resourceId', () => {
    expect(selectorToProto(_id('com.app:id/foo'))).toEqual({ resourceId: 'com.app:id/foo' });
  });

  it('serializes xpath selector', () => {
    expect(selectorToProto(_xpath('//Button'))).toEqual({ xpath: '//Button' });
  });

  it('serializes nested parent selectors', () => {
    const child = withParent(_text('Item'), _role('list'));
    expect(selectorToProto(child)).toEqual({
      text: 'Item',
      parent: { role: { role: 'list', name: '' } },
    });
  });

  it('serializes deeply nested selectors', () => {
    const child = withParent(
      _text('Label'),
      withParent(_className('Container'), _id('root')),
    );
    expect(selectorToProto(child)).toEqual({
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
    expect(selectorToProto(_text(''))).toEqual({ text: '' });
  });
});
