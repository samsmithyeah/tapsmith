/**
 * eslint-plugin-pilot
 *
 * ESLint rules that encourage accessible, maintainable selectors in Pilot
 * tests.
 *
 * Rules:
 *   - prefer-role: Warns when `.locator({ className })` is used for standard
 *     Android widgets that have well-known accessibility roles.
 *   - no-bare-locator-xpath: Errors when `.locator({ xpath })` is used without
 *     an explanatory comment on the same or preceding line.
 *   - prefer-accessible-selectors: Warns when `.getByTestId()` or
 *     `.locator({ id })` is used instead of `getByRole`, `getByText`,
 *     `getByDescription`, etc.
 */

// We define our own minimal types to avoid a hard dependency on @types/eslint.

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

interface SourceCode {
  getCommentsBefore(node: ASTNode): Comment[];
  getAllComments(): Comment[];
}

interface RuleContext {
  report(descriptor: {
    node: ASTNode;
    messageId: string;
    data?: Record<string, string>;
  }): void;
  sourceCode?: SourceCode;
  getSourceCode(): SourceCode;
}

interface RuleModule {
  meta: {
    type: string;
    docs: { description: string; recommended: boolean };
    messages: Record<string, string>;
    schema: unknown[];
  };
  create(context: RuleContext): Record<string, (node: ASTNode) => void>;
}

// ─── Helpers ───

/** Returns true if `node` is a CallExpression of the form `<obj>.<methodName>(...)`. */
function isMethodCall(node: ASTNode, methodName: string): boolean {
  return (
    node.type === 'CallExpression' &&
    node.callee?.type === 'MemberExpression' &&
    node.callee.computed !== true &&
    node.callee.property?.type === 'Identifier' &&
    node.callee.property.name === methodName
  );
}

/** Look up a property in an ObjectExpression by its (Identifier or Literal) key. */
function getObjectProperty(obj: ASTNode | undefined, key: string): ASTNode | undefined {
  if (!obj || obj.type !== 'ObjectExpression' || !obj.properties) return undefined;
  for (const prop of obj.properties) {
    if (prop.type !== 'Property') continue;
    const k = prop.key;
    if (!k) continue;
    if (k.type === 'Identifier' && k.name === key) return prop.value as ASTNode;
    if (k.type === 'Literal' && k.value === key) return prop.value as ASTNode;
  }
  return undefined;
}

function literalString(node: ASTNode | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  return undefined;
}

// ─── Standard widgets that should use getByRole instead of locator({className}) ───

const STANDARD_WIDGET_MAP: Record<string, string> = {
  'android.widget.Button': 'button',
  'android.widget.CheckBox': 'checkbox',
  'android.widget.EditText': 'textfield',
  'android.widget.ImageButton': 'button',
  'android.widget.ImageView': 'image',
  'android.widget.ProgressBar': 'progressbar',
  'android.widget.RadioButton': 'radio',
  'android.widget.SeekBar': 'slider',
  'android.widget.Spinner': 'combobox',
  'android.widget.Switch': 'switch',
  'android.widget.TextView': 'text',
  'android.widget.ToggleButton': 'togglebutton',
};

// ─── prefer-role ───

const preferRole: RuleModule = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Prefer getByRole() over locator({ className }) for standard Android widgets',
      recommended: true,
    },
    messages: {
      preferRole:
        'Use getByRole("{{role}}") instead of locator({ className: "{{className}}" }). Role-based selectors are more resilient to implementation changes.',
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node: ASTNode) {
        if (!isMethodCall(node, 'locator')) return;
        const arg = node.arguments?.[0];
        const classNameValue = literalString(getObjectProperty(arg, 'className'));
        if (!classNameValue) return;
        const role = STANDARD_WIDGET_MAP[classNameValue];
        if (!role) return;
        context.report({
          node,
          messageId: 'preferRole',
          data: { role, className: classNameValue },
        });
      },
    };
  },
};

// ─── no-bare-locator-xpath ───

const noBareLocatorXpath: RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require an explanatory comment when using locator({ xpath }) selectors',
      recommended: true,
    },
    messages: {
      noBareLocatorXpath:
        'locator({ xpath }) must have an explanatory comment on the same or preceding line. XPath selectors are fragile and Android-only — document why this is necessary.',
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node: ASTNode) {
        if (!isMethodCall(node, 'locator')) return;
        const arg = node.arguments?.[0];
        if (getObjectProperty(arg, 'xpath') === undefined) return;

        const sourceCode = context.sourceCode ?? context.getSourceCode();
        const comments = sourceCode.getCommentsBefore(node);
        if (comments.length > 0) return;

        const allComments = sourceCode.getAllComments();
        const nodeLine = node.loc?.start.line;
        const hasInlineComment = allComments.some(
          (c) => c.loc?.start.line === nodeLine || c.loc?.end.line === nodeLine,
        );
        if (hasInlineComment) return;

        context.report({ node, messageId: 'noBareLocatorXpath' });
      },
    };
  },
};

// ─── prefer-accessible-selectors ───

const preferAccessibleSelectors: RuleModule = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Prefer accessible getters (getByRole, getByText, getByDescription) over getByTestId / locator({ id })',
      recommended: true,
    },
    messages: {
      preferAccessibleTestId:
        'Prefer getByRole(), getByText(), or getByDescription() over getByTestId(). Accessible getters make tests more resilient and verify accessibility.',
      preferAccessibleId:
        'Prefer getByRole(), getByText(), or getByDescription() over locator({ id }). Accessible getters make tests more resilient and verify accessibility.',
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node: ASTNode) {
        if (isMethodCall(node, 'getByTestId')) {
          context.report({ node, messageId: 'preferAccessibleTestId' });
          return;
        }
        if (isMethodCall(node, 'locator')) {
          const arg = node.arguments?.[0];
          if (getObjectProperty(arg, 'id') !== undefined) {
            context.report({ node, messageId: 'preferAccessibleId' });
          }
        }
      },
    };
  },
};

// ─── Plugin export ───

const rules: Record<string, RuleModule> = {
  'prefer-role': preferRole,
  'no-bare-locator-xpath': noBareLocatorXpath,
  'prefer-accessible-selectors': preferAccessibleSelectors,
};

const recommendedConfig = {
  plugins: ['pilot'] as const,
  rules: {
    'pilot/prefer-role': 'warn' as const,
    'pilot/no-bare-locator-xpath': 'error' as const,
    'pilot/prefer-accessible-selectors': 'warn' as const,
  },
};

export { rules, recommendedConfig as configs };
export default { rules, configs: { recommended: recommendedConfig } };
