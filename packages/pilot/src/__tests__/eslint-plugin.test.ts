import { describe, it, expect, vi } from 'vitest';
import plugin from '../eslint-plugin/index.js';

// ─── Test helpers ───

interface ASTNode {
  type: string;
  callee?: ASTNode;
  object?: ASTNode;
  property?: ASTNode;
  computed?: boolean;
  name?: string;
  arguments?: ASTNode[];
  properties?: ASTNode[];
  key?: ASTNode;
  value?: unknown;
  loc?: { start: { line: number }; end: { line: number } };
}

interface Comment {
  loc?: { start: { line: number }; end: { line: number } };
}

interface ReportDescriptor {
  node: ASTNode;
  messageId: string;
  data?: Record<string, string>;
}

interface RuleContext {
  report(descriptor: ReportDescriptor): void;
  sourceCode?: {
    getCommentsBefore(node: ASTNode): Comment[];
    getAllComments(): Comment[];
  };
  getSourceCode(): {
    getCommentsBefore(node: ASTNode): Comment[];
    getAllComments(): Comment[];
  };
}

/**
 * Build an AST node representing `device.<methodName>(<arg>)`. The arg is
 * either an ObjectExpression (locator()) or a string Literal (getByTestId()).
 */
function makeMethodCall(methodName: string, arg?: ASTNode): ASTNode {
  return {
    type: 'CallExpression',
    callee: {
      type: 'MemberExpression',
      object: { type: 'Identifier', name: 'device' },
      property: { type: 'Identifier', name: methodName },
      computed: false,
    },
    arguments: arg ? [arg] : [],
    loc: { start: { line: 5 }, end: { line: 5 } },
  };
}

function objectExpr(props: Array<{ key: string; value: unknown }>): ASTNode {
  return {
    type: 'ObjectExpression',
    properties: props.map((p) => ({
      type: 'Property',
      key: { type: 'Identifier', name: p.key },
      value: { type: 'Literal', value: p.value },
    })),
  };
}

function stringLit(value: string): ASTNode {
  return { type: 'Literal', value };
}

function makeContext(reports: ReportDescriptor[] = [], comments: Comment[] = []): RuleContext {
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

  it('warns when locator({className}) is a standard Android widget (Button)', () => {
    const reports: ReportDescriptor[] = [];
    const ctx = makeContext(reports);
    const visitor = rule.create(ctx);

    visitor.CallExpression(
      makeMethodCall('locator', objectExpr([{ key: 'className', value: 'android.widget.Button' }])),
    );

    expect(reports).toHaveLength(1);
    expect(reports[0].messageId).toBe('preferRole');
    expect(reports[0].data?.role).toBe('button');
    expect(reports[0].data?.className).toBe('android.widget.Button');
  });

  it('warns for other standard widgets', () => {
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
      const visitor = rule.create(makeContext(reports));

      visitor.CallExpression(
        makeMethodCall('locator', objectExpr([{ key: 'className', value: className }])),
      );

      expect(reports).toHaveLength(1);
      expect(reports[0].data?.role).toBe(role);
    }
  });

  it('does not warn for custom/non-standard class names', () => {
    const reports: ReportDescriptor[] = [];
    const visitor = rule.create(makeContext(reports));

    visitor.CallExpression(
      makeMethodCall('locator', objectExpr([{ key: 'className', value: 'com.custom.Widget' }])),
    );

    expect(reports).toHaveLength(0);
  });

  it('does not warn for getByText() calls', () => {
    const reports: ReportDescriptor[] = [];
    const visitor = rule.create(makeContext(reports));

    visitor.CallExpression(makeMethodCall('getByText', stringLit('android.widget.Button')));

    expect(reports).toHaveLength(0);
  });

  it('does not warn for locator({id}) (no className)', () => {
    const reports: ReportDescriptor[] = [];
    const visitor = rule.create(makeContext(reports));

    visitor.CallExpression(makeMethodCall('locator', objectExpr([{ key: 'id', value: 'foo' }])));

    expect(reports).toHaveLength(0);
  });

  it('does not warn when locator() has no arguments', () => {
    const reports: ReportDescriptor[] = [];
    const visitor = rule.create(makeContext(reports));

    visitor.CallExpression(makeMethodCall('locator'));

    expect(reports).toHaveLength(0);
  });
});

// ─── no-bare-locator-xpath ───

describe('no-bare-locator-xpath rule', () => {
  const rule = plugin.rules['no-bare-locator-xpath'];

  it('has correct metadata', () => {
    expect(rule.meta.type).toBe('problem');
    expect(rule.meta.messages.noBareLocatorXpath).toBeDefined();
  });

  it('reports error when locator({xpath}) has no comment', () => {
    const reports: ReportDescriptor[] = [];
    const visitor = rule.create(makeContext(reports, []));

    visitor.CallExpression(
      makeMethodCall('locator', objectExpr([{ key: 'xpath', value: '//Button' }])),
    );

    expect(reports).toHaveLength(1);
    expect(reports[0].messageId).toBe('noBareLocatorXpath');
  });

  it('does not report when locator({xpath}) has a comment before it', () => {
    const reports: ReportDescriptor[] = [];
    const sourceCode = {
      getCommentsBefore: vi.fn(() => [{ loc: { start: { line: 4 }, end: { line: 4 } } }]),
      getAllComments: vi.fn(() => []),
    };
    const ctx: RuleContext = {
      report: vi.fn((desc: ReportDescriptor) => reports.push(desc)),
      sourceCode,
      getSourceCode: () => sourceCode,
    };
    const visitor = rule.create(ctx);

    visitor.CallExpression(
      makeMethodCall('locator', objectExpr([{ key: 'xpath', value: '//Button' }])),
    );

    expect(reports).toHaveLength(0);
  });

  it('does not report when locator({xpath}) has an inline comment on the same line', () => {
    const reports: ReportDescriptor[] = [];
    const inlineComment = { loc: { start: { line: 5 }, end: { line: 5 } } };
    const visitor = rule.create(makeContext(reports, [inlineComment]));

    visitor.CallExpression(
      makeMethodCall('locator', objectExpr([{ key: 'xpath', value: '//Button' }])),
    );

    expect(reports).toHaveLength(0);
  });

  it('does not report for locator({id}) (not xpath)', () => {
    const reports: ReportDescriptor[] = [];
    const visitor = rule.create(makeContext(reports, []));

    visitor.CallExpression(makeMethodCall('locator', objectExpr([{ key: 'id', value: 'foo' }])));

    expect(reports).toHaveLength(0);
  });

  it('reports when comment is on a different line', () => {
    const reports: ReportDescriptor[] = [];
    const differentLineComment = { loc: { start: { line: 1 }, end: { line: 1 } } };
    const visitor = rule.create(makeContext(reports, [differentLineComment]));

    visitor.CallExpression(
      makeMethodCall('locator', objectExpr([{ key: 'xpath', value: '//Button' }])),
    );

    expect(reports).toHaveLength(1);
  });
});

// ─── prefer-accessible-selectors ───

describe('prefer-accessible-selectors rule', () => {
  const rule = plugin.rules['prefer-accessible-selectors'];

  it('has correct metadata', () => {
    expect(rule.meta.type).toBe('suggestion');
    expect(rule.meta.messages.preferAccessibleTestId).toBeDefined();
    expect(rule.meta.messages.preferAccessibleId).toBeDefined();
  });

  it('warns when getByTestId() is used', () => {
    const reports: ReportDescriptor[] = [];
    const visitor = rule.create(makeContext(reports));

    visitor.CallExpression(makeMethodCall('getByTestId', stringLit('btn-submit')));

    expect(reports).toHaveLength(1);
    expect(reports[0].messageId).toBe('preferAccessibleTestId');
  });

  it('warns when locator({id}) is used', () => {
    const reports: ReportDescriptor[] = [];
    const visitor = rule.create(makeContext(reports));

    visitor.CallExpression(
      makeMethodCall('locator', objectExpr([{ key: 'id', value: 'com.app:id/btn' }])),
    );

    expect(reports).toHaveLength(1);
    expect(reports[0].messageId).toBe('preferAccessibleId');
  });

  it('does not warn for getByRole()', () => {
    const reports: ReportDescriptor[] = [];
    const visitor = rule.create(makeContext(reports));

    visitor.CallExpression(makeMethodCall('getByRole', stringLit('button')));

    expect(reports).toHaveLength(0);
  });

  it('does not warn for getByText()', () => {
    const reports: ReportDescriptor[] = [];
    const visitor = rule.create(makeContext(reports));

    visitor.CallExpression(makeMethodCall('getByText', stringLit('Hello')));

    expect(reports).toHaveLength(0);
  });

  it('does not warn for getByDescription()', () => {
    const reports: ReportDescriptor[] = [];
    const visitor = rule.create(makeContext(reports));

    visitor.CallExpression(makeMethodCall('getByDescription', stringLit('Close')));

    expect(reports).toHaveLength(0);
  });

  it('does not warn for locator({xpath}) (handled by no-bare-locator-xpath)', () => {
    const reports: ReportDescriptor[] = [];
    const visitor = rule.create(makeContext(reports));

    visitor.CallExpression(
      makeMethodCall('locator', objectExpr([{ key: 'xpath', value: '//Button' }])),
    );

    expect(reports).toHaveLength(0);
  });

  it('does not warn for unrelated functions', () => {
    const reports: ReportDescriptor[] = [];
    const visitor = rule.create(makeContext(reports));

    visitor.CallExpression(makeMethodCall('querySelector', stringLit('#btn')));

    expect(reports).toHaveLength(0);
  });
});

// ─── Plugin exports ───

describe('plugin exports', () => {
  it('exports rules object with all three rules', () => {
    expect(plugin.rules).toBeDefined();
    expect(plugin.rules['prefer-role']).toBeDefined();
    expect(plugin.rules['no-bare-locator-xpath']).toBeDefined();
    expect(plugin.rules['prefer-accessible-selectors']).toBeDefined();
  });

  it('exports recommended config', () => {
    expect(plugin.configs).toBeDefined();
    expect(plugin.configs.recommended).toBeDefined();
    expect(plugin.configs.recommended.rules).toEqual({
      'pilot/prefer-role': 'warn',
      'pilot/no-bare-locator-xpath': 'error',
      'pilot/prefer-accessible-selectors': 'warn',
    });
  });
});
