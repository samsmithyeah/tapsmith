import { describe, it, expect, vi } from 'vitest';
import plugin from '../eslint-plugin/index.js';

// ─── Test helpers ───

interface ReportDescriptor {
  node: unknown;
  messageId: string;
  data?: Record<string, string>;
}

function makeNode(calleeName: string, args: Array<{ type: string; value?: unknown }> = []) {
  return {
    type: 'CallExpression',
    callee: { type: 'Identifier', name: calleeName },
    arguments: args,
    loc: { start: { line: 5 }, end: { line: 5 } },
  };
}

function makeContext(reports: ReportDescriptor[] = [], comments: Array<{ loc?: { start: { line: number }; end: { line: number } } }> = []) {
  const sourceCode = {
    getCommentsBefore: vi.fn(() => []),
    getAllComments: vi.fn(() => comments),
  };
  return {
    report: vi.fn((desc: ReportDescriptor) => reports.push(desc)),
    sourceCode,
    getSourceCode: () => sourceCode,
  };
}

// ─── prefer-role ───

describe('prefer-role rule', () => {
  const rule = plugin.rules['prefer-role'];

  it('has correct metadata', () => {
    expect(rule.meta.type).toBe('suggestion');
    expect(rule.meta.messages.preferRole).toBeDefined();
  });

  it('warns when className is a standard Android widget (Button)', () => {
    const reports: ReportDescriptor[] = [];
    const ctx = makeContext(reports);
    const visitor = rule.create(ctx as any);

    const node = makeNode('className', [{ type: 'Literal', value: 'android.widget.Button' }]);
    visitor.CallExpression(node as any);

    expect(reports).toHaveLength(1);
    expect(reports[0].messageId).toBe('preferRole');
    expect(reports[0].data?.role).toBe('button');
    expect(reports[0].data?.className).toBe('android.widget.Button');
  });

  it('warns for other standard widgets (CheckBox, EditText, Switch)', () => {
    const standardWidgets = [
      { className: 'android.widget.CheckBox', role: 'checkbox' },
      { className: 'android.widget.EditText', role: 'textfield' },
      { className: 'android.widget.Switch', role: 'switch' },
      { className: 'android.widget.ImageView', role: 'image' },
      { className: 'android.widget.RadioButton', role: 'radio' },
      { className: 'android.widget.SeekBar', role: 'slider' },
      { className: 'android.widget.Spinner', role: 'combobox' },
      { className: 'android.widget.TextView', role: 'text' },
      { className: 'android.widget.ToggleButton', role: 'togglebutton' },
      { className: 'android.widget.ProgressBar', role: 'progressbar' },
      { className: 'android.widget.ImageButton', role: 'button' },
    ];

    for (const { className, role } of standardWidgets) {
      const reports: ReportDescriptor[] = [];
      const ctx = makeContext(reports);
      const visitor = rule.create(ctx as any);

      const node = makeNode('className', [{ type: 'Literal', value: className }]);
      visitor.CallExpression(node as any);

      expect(reports).toHaveLength(1);
      expect(reports[0].data?.role).toBe(role);
    }
  });

  it('does not warn for custom/non-standard class names', () => {
    const reports: ReportDescriptor[] = [];
    const ctx = makeContext(reports);
    const visitor = rule.create(ctx as any);

    const node = makeNode('className', [{ type: 'Literal', value: 'com.custom.Widget' }]);
    visitor.CallExpression(node as any);

    expect(reports).toHaveLength(0);
  });

  it('does not warn for non-className function calls', () => {
    const reports: ReportDescriptor[] = [];
    const ctx = makeContext(reports);
    const visitor = rule.create(ctx as any);

    const node = makeNode('text', [{ type: 'Literal', value: 'android.widget.Button' }]);
    visitor.CallExpression(node as any);

    expect(reports).toHaveLength(0);
  });

  it('does not warn when argument is not a string literal', () => {
    const reports: ReportDescriptor[] = [];
    const ctx = makeContext(reports);
    const visitor = rule.create(ctx as any);

    const node = makeNode('className', [{ type: 'Identifier' }]);
    visitor.CallExpression(node as any);

    expect(reports).toHaveLength(0);
  });

  it('does not warn when className has no arguments', () => {
    const reports: ReportDescriptor[] = [];
    const ctx = makeContext(reports);
    const visitor = rule.create(ctx as any);

    const node = makeNode('className', []);
    visitor.CallExpression(node as any);

    expect(reports).toHaveLength(0);
  });
});

// ─── no-bare-xpath ───

describe('no-bare-xpath rule', () => {
  const rule = plugin.rules['no-bare-xpath'];

  it('has correct metadata', () => {
    expect(rule.meta.type).toBe('problem');
    expect(rule.meta.messages.noBareXpath).toBeDefined();
  });

  it('reports error when xpath() has no comment', () => {
    const reports: ReportDescriptor[] = [];
    const ctx = makeContext(reports, []);
    const visitor = rule.create(ctx as any);

    const node = makeNode('xpath', [{ type: 'Literal', value: '//Button' }]);
    visitor.CallExpression(node as any);

    expect(reports).toHaveLength(1);
    expect(reports[0].messageId).toBe('noBareXpath');
  });

  it('does not report when xpath() has a comment before it', () => {
    const reports: ReportDescriptor[] = [];
    const sourceCode = {
      getCommentsBefore: vi.fn(() => [{ loc: { start: { line: 4 }, end: { line: 4 } } }]),
      getAllComments: vi.fn(() => []),
    };
    const ctx = {
      report: vi.fn((desc: ReportDescriptor) => reports.push(desc)),
      sourceCode,
      getSourceCode: () => sourceCode,
    };
    const visitor = rule.create(ctx as any);

    const node = makeNode('xpath', [{ type: 'Literal', value: '//Button' }]);
    visitor.CallExpression(node as any);

    expect(reports).toHaveLength(0);
  });

  it('does not report when xpath() has an inline comment on the same line', () => {
    const reports: ReportDescriptor[] = [];
    const inlineComment = { loc: { start: { line: 5 }, end: { line: 5 } } };
    const ctx = makeContext(reports, [inlineComment]);
    const visitor = rule.create(ctx as any);

    const node = makeNode('xpath', [{ type: 'Literal', value: '//Button' }]);
    visitor.CallExpression(node as any);

    expect(reports).toHaveLength(0);
  });

  it('does not report for non-xpath function calls', () => {
    const reports: ReportDescriptor[] = [];
    const ctx = makeContext(reports, []);
    const visitor = rule.create(ctx as any);

    const node = makeNode('text', [{ type: 'Literal', value: '//Button' }]);
    visitor.CallExpression(node as any);

    expect(reports).toHaveLength(0);
  });

  it('reports when comment is on a different line', () => {
    const reports: ReportDescriptor[] = [];
    const differentLineComment = { loc: { start: { line: 1 }, end: { line: 1 } } };
    const ctx = makeContext(reports, [differentLineComment]);
    const visitor = rule.create(ctx as any);

    const node = makeNode('xpath', [{ type: 'Literal', value: '//Button' }]);
    visitor.CallExpression(node as any);

    expect(reports).toHaveLength(1);
  });
});

// ─── prefer-accessible-selectors ───

describe('prefer-accessible-selectors rule', () => {
  const rule = plugin.rules['prefer-accessible-selectors'];

  it('has correct metadata', () => {
    expect(rule.meta.type).toBe('suggestion');
    expect(rule.meta.messages.preferAccessible).toBeDefined();
  });

  it('warns when testId() is used', () => {
    const reports: ReportDescriptor[] = [];
    const ctx = makeContext(reports);
    const visitor = rule.create(ctx as any);

    const node = makeNode('testId', [{ type: 'Literal', value: 'btn-submit' }]);
    visitor.CallExpression(node as any);

    expect(reports).toHaveLength(1);
    expect(reports[0].messageId).toBe('preferAccessible');
    expect(reports[0].data?.name).toBe('testId');
  });

  it('warns when id() is used', () => {
    const reports: ReportDescriptor[] = [];
    const ctx = makeContext(reports);
    const visitor = rule.create(ctx as any);

    const node = makeNode('id', [{ type: 'Literal', value: 'com.app:id/btn' }]);
    visitor.CallExpression(node as any);

    expect(reports).toHaveLength(1);
    expect(reports[0].messageId).toBe('preferAccessible');
    expect(reports[0].data?.name).toBe('id');
  });

  it('does not warn for role()', () => {
    const reports: ReportDescriptor[] = [];
    const ctx = makeContext(reports);
    const visitor = rule.create(ctx as any);

    const node = makeNode('role', [{ type: 'Literal', value: 'button' }]);
    visitor.CallExpression(node as any);

    expect(reports).toHaveLength(0);
  });

  it('does not warn for text()', () => {
    const reports: ReportDescriptor[] = [];
    const ctx = makeContext(reports);
    const visitor = rule.create(ctx as any);

    const node = makeNode('text', [{ type: 'Literal', value: 'Hello' }]);
    visitor.CallExpression(node as any);

    expect(reports).toHaveLength(0);
  });

  it('does not warn for contentDesc()', () => {
    const reports: ReportDescriptor[] = [];
    const ctx = makeContext(reports);
    const visitor = rule.create(ctx as any);

    const node = makeNode('contentDesc', [{ type: 'Literal', value: 'Close' }]);
    visitor.CallExpression(node as any);

    expect(reports).toHaveLength(0);
  });

  it('does not warn for textContains()', () => {
    const reports: ReportDescriptor[] = [];
    const ctx = makeContext(reports);
    const visitor = rule.create(ctx as any);

    const node = makeNode('textContains', [{ type: 'Literal', value: 'partial' }]);
    visitor.CallExpression(node as any);

    expect(reports).toHaveLength(0);
  });

  it('does not warn for unrelated functions', () => {
    const reports: ReportDescriptor[] = [];
    const ctx = makeContext(reports);
    const visitor = rule.create(ctx as any);

    const node = makeNode('querySelector', [{ type: 'Literal', value: '#btn' }]);
    visitor.CallExpression(node as any);

    expect(reports).toHaveLength(0);
  });
});

// ─── Plugin exports ───

describe('plugin exports', () => {
  it('exports rules object with all three rules', () => {
    expect(plugin.rules).toBeDefined();
    expect(plugin.rules['prefer-role']).toBeDefined();
    expect(plugin.rules['no-bare-xpath']).toBeDefined();
    expect(plugin.rules['prefer-accessible-selectors']).toBeDefined();
  });

  it('exports recommended config', () => {
    expect(plugin.configs).toBeDefined();
    expect(plugin.configs.recommended).toBeDefined();
    expect(plugin.configs.recommended.rules).toEqual({
      'pilot/prefer-role': 'warn',
      'pilot/no-bare-xpath': 'error',
      'pilot/prefer-accessible-selectors': 'warn',
    });
  });
});
