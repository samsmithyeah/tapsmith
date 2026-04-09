/**
 * Selectors — internal representation of how to locate UI elements.
 *
 * The public API is `device.getByText()`, `device.getByRole()`, etc. (see
 * `device.ts`). Selector values are an implementation detail of how those
 * methods communicate with the daemon over gRPC. Nothing in this file is
 * part of the user-facing surface.
 *
 * @internal
 */

// ─── Types ───

export interface RoleSelectorValue {
  role: string;
  name: string;
}

export type SelectorKind =
  | { type: 'role'; value: RoleSelectorValue }
  | { type: 'text'; value: string }
  | { type: 'textContains'; value: string }
  | { type: 'contentDesc'; value: string }
  | { type: 'hint'; value: string }
  | { type: 'className'; value: string }
  | { type: 'testId'; value: string }
  | { type: 'id'; value: string }
  | { type: 'xpath'; value: string };

/**
 * A Selector identifies a UI element. Internal representation only.
 *
 * @internal
 */
export interface Selector {
  readonly kind: SelectorKind;
  readonly parent?: Selector;
}

// ─── Internal helpers ───

/** @internal */
export function makeSelector(kind: SelectorKind, parent?: Selector): Selector {
  return { kind, parent };
}

/** @internal — Return a new selector scoped within `parent`. */
export function withParent(child: Selector, parent: Selector): Selector {
  return { kind: child.kind, parent };
}

// ─── Proto serialization ───

/**
 * Converts a Selector into the proto-compatible shape expected by the gRPC
 * layer. This is the only place that knows about the protobuf message layout.
 *
 * @internal
 */
export function selectorToProto(selector: Selector): Record<string, unknown> {
  const proto: Record<string, unknown> = {};

  switch (selector.kind.type) {
    case 'role':
      proto.role = {
        role: selector.kind.value.role,
        name: selector.kind.value.name,
      };
      break;
    case 'text':
      proto.text = selector.kind.value;
      break;
    case 'textContains':
      proto.textContains = selector.kind.value;
      break;
    case 'contentDesc':
      proto.contentDesc = selector.kind.value;
      break;
    case 'hint':
      proto.hint = selector.kind.value;
      break;
    case 'className':
      proto.className = selector.kind.value;
      break;
    case 'testId':
      proto.testId = selector.kind.value;
      break;
    case 'id':
      proto.resourceId = selector.kind.value;
      break;
    case 'xpath':
      proto.xpath = selector.kind.value;
      break;
  }

  if (selector.parent) {
    proto.parent = selectorToProto(selector.parent);
  }

  return proto;
}

// ─── Internal builders (used by Device/ElementHandle getBy* methods) ───

/** @internal */
export function _role(roleName: string, name?: string): Selector {
  return makeSelector({ type: 'role', value: { role: roleName, name: name ?? '' } });
}

/** @internal */
export function _text(exactText: string): Selector {
  return makeSelector({ type: 'text', value: exactText });
}

/** @internal */
export function _textContains(partial: string): Selector {
  return makeSelector({ type: 'textContains', value: partial });
}

/** @internal */
export function _contentDesc(desc: string): Selector {
  return makeSelector({ type: 'contentDesc', value: desc });
}

/** @internal */
export function _hint(hintText: string): Selector {
  return makeSelector({ type: 'hint', value: hintText });
}

/** @internal */
export function _className(name: string): Selector {
  return makeSelector({ type: 'className', value: name });
}

/** @internal */
export function _testId(id: string): Selector {
  return makeSelector({ type: 'testId', value: id });
}

/** @internal */
export function _id(resourceId: string): Selector {
  return makeSelector({ type: 'id', value: resourceId });
}

/** @internal */
export function _xpath(expr: string): Selector {
  return makeSelector({ type: 'xpath', value: expr });
}
