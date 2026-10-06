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
  _label,
  withParent,
  selectorToProto,
  formatSelector,
} from '../selectors.js';
import { translateRegex } from '../text-regex.js';

// ─── Internal selector builders ───

describe('internal selector builders', () => {
  it('_role() creates a role selector with role and name', () => {
    const sel = _role('button', { name: 'Submit' });
    expect(sel.kind).toEqual({ type: 'role', value: { role: 'button', name: 'Submit' } });
    expect(sel.parent).toBeUndefined();
  });

  it('_role() rejects an unknown role when the locator is built (PILOT-556)', () => {
    expect(() => _role('list2')).toThrow(/^Unknown role "list2"\. Supported: alert, button, /);
    expect(() => _role('textbox', { name: 'Email' })).toThrow('Did you mean "textfield"?');
  });

  it('_role() keeps the role as written for a known role in any case or alias', () => {
    expect(_role('Button').kind).toEqual({ type: 'role', value: { role: 'Button', name: '' } });
    expect(_role('header').kind).toEqual({ type: 'role', value: { role: 'header', name: '' } });
  });

  it('_role() throws a TypeError for a non-string role', () => {
    expect(() => _role(undefined as unknown as string)).toThrow('getByRole() expects a role name string, got undefined.');
  });

  it('_role() defaults name to empty string when omitted', () => {
    const sel = _role('checkbox');
    expect(sel.kind).toEqual({ type: 'role', value: { role: 'checkbox', name: '' } });
  });

  it('_role() accepts state filter options', () => {
    const sel = _role('switch', { name: 'Dark Mode', checked: true, disabled: false });
    expect(sel.kind).toEqual({
      type: 'role',
      value: { role: 'switch', name: 'Dark Mode', checked: true, disabled: false },
    });
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

  it('_label() creates a label selector', () => {
    expect(_label('Email').kind).toEqual({ type: 'label', value: 'Email' });
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
      _label('hi'),
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
    const grandparent = _role('toolbar');
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
    expect(selectorToProto(_role('button', { name: 'OK' }))).toEqual({ role: { role: 'button', name: 'OK' } });
  });

  it('serializes role selector with checked option', () => {
    expect(selectorToProto(_role('switch', { name: 'Dark Mode', checked: true }))).toEqual({
      role: { role: 'switch', name: 'Dark Mode', checked: true },
    });
  });

  it('serializes role selector with disabled option', () => {
    expect(selectorToProto(_role('button', { name: 'Submit', disabled: true }))).toEqual({
      role: { role: 'button', name: 'Submit', disabled: true },
    });
  });

  it('serializes role selector with selected and expanded options', () => {
    expect(selectorToProto(_role('tab', { selected: true, expanded: false }))).toEqual({
      role: { role: 'tab', name: '', selected: true, expanded: false },
    });
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

  it('serializes label selector', () => {
    expect(selectorToProto(_label('Email'))).toEqual({ label: 'Email' });
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

describe('getByRole name matching options (PILOT-549)', () => {
  it('_role() records exact only when it is true', () => {
    expect(_role('button', { name: 'Sign In', exact: true }).kind).toEqual({
      type: 'role', value: { role: 'button', name: 'Sign In', exact: true },
    });
    expect(_role('button', { name: 'Sign In', exact: false }).kind).toEqual({
      type: 'role', value: { role: 'button', name: 'Sign In' },
    });
  });

  it('serializes exact into the role message, and omits it by default', () => {
    expect(selectorToProto(_role('button', { name: 'Sign In', exact: true }))).toEqual({
      role: { role: 'button', name: 'Sign In', exact: true },
    });
    expect(selectorToProto(_role('button', { name: 'Sign In' }))).toEqual({
      role: { role: 'button', name: 'Sign In' },
    });
  });

  it('ignores exact without a name, as Playwright does', () => {
    expect(selectorToProto(_role('button', { exact: true }))).toEqual({ role: { role: 'button', name: '' } });
  });

  it('formats the locator as valid code', () => {
    expect(formatSelector(_role('button', { name: 'explor' }))).toBe('getByRole("button", { name: "explor" })');
    expect(formatSelector(_role('button', { name: 'Sign In', exact: true })))
      .toBe('getByRole("button", { name: "Sign In", exact: true })');
    expect(formatSelector(_role('button'))).toBe('getByRole("button")');
  });

  it('formats state filters too, so the locator can be pasted back', () => {
    expect(formatSelector(_role('button', { name: 'Item 3', exact: true, selected: true })))
      .toBe('getByRole("button", { name: "Item 3", exact: true, selected: true })');
    expect(formatSelector(_role('switch', { checked: false }))).toBe('getByRole("switch", { checked: false })');
  });

  it('escapes quotes in the formatted name', () => {
    expect(formatSelector(_role('button', { name: 'Say "hi"' }))).toBe('getByRole("button", { name: "Say \\"hi\\"" })');
  });
});

describe('RegExp locators (PILOT-520)', () => {
  it('getByText(RegExp) builds a textRegex selector, exact or not', () => {
    for (const sel of [_textContains(/Welcome\sto/i), _text(/Welcome\sto/i)]) {
      expect(sel.kind.type).toBe('textRegex');
      expect(sel.kind.value).toMatchObject({ source: 'Welcome\\sto', flags: 'i', ignoreCase: true });
    }
  });

  it('serializes the device pattern, the i flag and the literal for display', () => {
    const proto = selectorToProto(_textContains(/^Save\sdraft$/i)) as { textRegex: Record<string, unknown> };
    expect(Object.keys(proto)).toEqual(['textRegex']);
    expect(proto.textRegex).toEqual({
      pattern: translateRegex('^Save\\sdraft$', 'i').pattern,
      ignoreCase: true,
      display: '/^Save\\sdraft$/i',
    });
    expect(selectorToProto(_label(/name/))).toEqual({
      labelRegex: { pattern: 'name', ignoreCase: false, display: '/name/' },
    });
  });

  it('getByRole name RegExp travels as nameRegex, and ignores exact', () => {
    const sel = _role('button', { name: /save/i, exact: true });
    expect(selectorToProto(sel)).toEqual({
      // `name` carries the literal so an agent without RegExp support
      // matches nothing rather than every button.
      role: { role: 'button', name: '/save/i', nameRegex: { pattern: 'save', ignoreCase: true, display: '/save/i' } },
    });
  });

  it('formats regex locators as valid code', () => {
    expect(formatSelector(_textContains(/a\/b\s/i))).toBe('getByText(/a\\/b\\s/i)');
    expect(formatSelector(_label(/full\sname/))).toBe('getByLabel(/full\\sname/)');
    expect(formatSelector(_role('button', { name: /^save/i, selected: true })))
      .toBe('getByRole("button", { name: /^save/i, selected: true })');
    expect(formatSelector(withParent(_textContains(/x/), _role('list')))).toBe('getByRole("list").getByText(/x/)');
  });

  it('rejects an unsupported flag at locator creation, naming the call', () => {
    expect(() => _textContains(/a/y)).toThrow(/getByText\(\) does not support the RegExp flag "y"/);
    expect(() => _role('button', { name: /a/y })).toThrow(/getByRole\(\) option `name` does not support the RegExp flag "y"/);
    expect(() => _label(/(?<=a+)b/)).toThrow(/getByLabel\(\).*lookbehind/);
  });
});
