import { parseSelectorString } from '../trace-viewer/components/selector-matching.js';
import type { Selector, SelectorKind } from '../selectors.js';
import { makeSelector } from '../selectors.js';

export function parseSelectorToInternal(input: string): Selector {
  const parsed = parseSelectorString(input);
  if (!parsed) {
    throw new Error(`Invalid selector: "${input}". Use a Pilot selector like device.getByRole("button", { name: "Login" })`);
  }

  let kind: SelectorKind;
  switch (parsed.type) {
    case 'text':
      kind = { type: 'text', value: parsed.value };
      break;
    case 'role':
      kind = { type: 'role', value: { role: parsed.value, name: parsed.name ?? '' } };
      break;
    case 'contentDesc':
      kind = { type: 'contentDesc', value: parsed.value };
      break;
    case 'hint':
      kind = { type: 'hint', value: parsed.value };
      break;
    case 'testId':
      kind = { type: 'testId', value: parsed.value };
      break;
    case 'className':
      kind = { type: 'className', value: parsed.value };
      break;
    case 'id':
      kind = { type: 'id', value: parsed.value };
      break;
    default:
      throw new Error(`Unsupported selector type "${parsed.type}" for device actions. Use device.getByRole(), getByText(), getByDescription(), getByPlaceholder(), or getByTestId().`);
  }

  return makeSelector(kind);
}
