/**
 * Assertion API for Pilot tests.
 *
 * Usage:
 *   // Locator assertions (auto-waiting)
 *   expect(device.element(text('Hello'))).toBeVisible();
 *   expect(device.element(role('button', 'Submit'))).not.toBeEnabled();
 *
 *   // Generic value assertions (PILOT-42)
 *   expect(5).toBe(5);
 *   expect("hello").toContain("ell");
 *
 *   // Soft assertions (PILOT-43)
 *   expect.soft(device.element(text('Header'))).toBeVisible();
 *
 *   // Poll assertions (PILOT-44)
 *   await expect.poll(async () => fetchCount()).toBe(5);
 */

import type { ElementHandle } from "./element-handle.js";
import type { ElementInfo } from "./grpc-client.js";
import { selectorToProto } from "./selectors.js";

const DEFAULT_ASSERTION_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 250;

/**
 * Repeatedly call `check` until it returns `true` or the timeout is exceeded.
 */
async function poll(
  check: () => Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  // Final attempt
  return check();
}

function selectorDescription(handle: ElementHandle): string {
  return JSON.stringify(selectorToProto(handle._selector));
}

// ─── Role-to-class mapping (mirrors Kotlin roleClassMap) ───

const ROLE_CLASS_MAP: Record<string, string[]> = {
  button: [
    "android.widget.Button",
    "android.widget.ImageButton",
    "com.google.android.material.button.MaterialButton",
    "androidx.appcompat.widget.AppCompatButton",
  ],
  textfield: [
    "android.widget.EditText",
    "android.widget.AutoCompleteTextView",
    "com.google.android.material.textfield.TextInputEditText",
    "androidx.appcompat.widget.AppCompatEditText",
  ],
  checkbox: [
    "android.widget.CheckBox",
    "androidx.appcompat.widget.AppCompatCheckBox",
    "com.google.android.material.checkbox.MaterialCheckBox",
  ],
  switch: [
    "android.widget.Switch",
    "androidx.appcompat.widget.SwitchCompat",
    "com.google.android.material.switchmaterial.SwitchMaterial",
  ],
  image: [
    "android.widget.ImageView",
    "androidx.appcompat.widget.AppCompatImageView",
  ],
  text: [
    "android.widget.TextView",
    "androidx.appcompat.widget.AppCompatTextView",
    "com.google.android.material.textview.MaterialTextView",
  ],
  heading: ["android.widget.TextView"],
  link: ["android.widget.TextView"],
  list: [
    "android.widget.ListView",
    "android.widget.GridView",
    "androidx.recyclerview.widget.RecyclerView",
  ],
  listitem: [
    "android.widget.LinearLayout",
    "android.widget.RelativeLayout",
    "android.widget.FrameLayout",
  ],
  scrollview: [
    "android.widget.ScrollView",
    "android.widget.HorizontalScrollView",
    "androidx.core.widget.NestedScrollView",
  ],
  progressbar: [
    "android.widget.ProgressBar",
    "com.google.android.material.progressindicator.LinearProgressIndicator",
    "com.google.android.material.progressindicator.CircularProgressIndicator",
  ],
  seekbar: [
    "android.widget.SeekBar",
    "com.google.android.material.slider.Slider",
  ],
  radiobutton: [
    "android.widget.RadioButton",
    "androidx.appcompat.widget.AppCompatRadioButton",
    "com.google.android.material.radiobutton.MaterialRadioButton",
  ],
  spinner: [
    "android.widget.Spinner",
    "androidx.appcompat.widget.AppCompatSpinner",
  ],
  toolbar: [
    "android.widget.Toolbar",
    "androidx.appcompat.widget.Toolbar",
    "com.google.android.material.appbar.MaterialToolbar",
  ],
  tab: [
    "android.widget.TabWidget",
    "com.google.android.material.tabs.TabLayout",
  ],
};

const EDITABLE_CLASSES = new Set(ROLE_CLASS_MAP["textfield"]);

const CLASS_TO_ROLE_MAP: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const [role, classes] of Object.entries(ROLE_CLASS_MAP)) {
    for (const className of classes) {
      if (!(className in map)) {
        map[className] = role;
      }
    }
  }
  return map;
})();

// ─── Assertion object ───

export interface PilotAssertions {
  /** Negate the following assertion. */
  not: PilotAssertions;

  /** Assert the element is visible on screen. */
  toBeVisible(options?: { timeout?: number }): Promise<void>;

  /** Assert the element is enabled (interactive). */
  toBeEnabled(options?: { timeout?: number }): Promise<void>;

  /** Assert the element's text content matches. */
  toHaveText(expected: string, options?: { timeout?: number }): Promise<void>;

  /** Assert the element exists in the UI hierarchy. */
  toExist(options?: { timeout?: number }): Promise<void>;

  /** Assert the element is in the checked state (checkbox, switch, radio). */
  toBeChecked(options?: { timeout?: number }): Promise<void>;

  /** Assert the element is disabled (not interactive). */
  toBeDisabled(options?: { timeout?: number }): Promise<void>;

  /** Assert the element is hidden (not visible or not in the hierarchy). */
  toBeHidden(options?: { timeout?: number }): Promise<void>;

  /** Assert the element has no text content. */
  toBeEmpty(options?: { timeout?: number }): Promise<void>;

  /** Assert the element currently has input/accessibility focus. */
  toBeFocused(options?: { timeout?: number }): Promise<void>;

  /** Assert the element's text contains the given substring or matches a regex. */
  toContainText(
    expected: string | RegExp,
    options?: { timeout?: number },
  ): Promise<void>;

  /** Assert the selector resolves to exactly N elements. */
  toHaveCount(count: number, options?: { timeout?: number }): Promise<void>;

  /** Assert the element has a specific attribute/property value. */
  toHaveAttribute(
    name: keyof ElementInfo,
    value: unknown,
    options?: { timeout?: number },
  ): Promise<void>;

  /** Assert the element has the given accessible name (contentDescription or text). */
  toHaveAccessibleName(
    name: string | RegExp,
    options?: { timeout?: number },
  ): Promise<void>;

  /** Assert the element has the given accessible description (hint). */
  toHaveAccessibleDescription(
    description: string | RegExp,
    options?: { timeout?: number },
  ): Promise<void>;

  /** Assert the element has a specific accessibility role. */
  toHaveRole(role: string, options?: { timeout?: number }): Promise<void>;

  /** Assert an input field contains a specific value. */
  toHaveValue(value: string, options?: { timeout?: number }): Promise<void>;

  /** Assert the element is an editable input field. */
  toBeEditable(options?: { timeout?: number }): Promise<void>;

  /** Assert the element is within the visible viewport. */
  toBeInViewport(options?: { timeout?: number; ratio?: number }): Promise<void>;
}

function matchesStringOrRegExp(
  actual: string,
  expected: string | RegExp,
): boolean {
  if (typeof expected === "string") {
    return actual.includes(expected);
  }
  return expected.test(actual);
}

function matchesExact(
  actual: string,
  expected: string | RegExp,
): boolean {
  if (typeof expected === "string") {
    return actual === expected;
  }
  return expected.test(actual);
}

function createAssertions(
  handle: ElementHandle,
  negated: boolean,
): PilotAssertions {
  const timeoutFor = (opts?: { timeout?: number }) =>
    opts?.timeout ?? handle._timeoutMs ?? DEFAULT_ASSERTION_TIMEOUT_MS;

  const fail = (message: string): never => {
    throw new Error(message);
  };

  const assertions: PilotAssertions = {
    get not(): PilotAssertions {
      return createAssertions(handle, !negated);
    },

    async toBeVisible(options) {
      const timeout = timeoutFor(options);
      const desc = selectorDescription(handle);
      const result = await poll(async () => {
        try {
          const res = await handle._client.findElement(handle._selector, 0);
          return res.found && res.element?.visible === true;
        } catch {
          return false;
        }
      }, timeout);

      if (!negated && !result) {
        fail(`Expected element ${desc} to be visible, but it was not`);
      }
      if (negated && result) {
        fail(`Expected element ${desc} NOT to be visible, but it was`);
      }
    },

    async toBeEnabled(options) {
      const timeout = timeoutFor(options);
      const desc = selectorDescription(handle);
      const result = await poll(async () => {
        try {
          const res = await handle._client.findElement(handle._selector, 0);
          return res.found && res.element?.enabled === true;
        } catch {
          return false;
        }
      }, timeout);

      if (!negated && !result) {
        fail(`Expected element ${desc} to be enabled, but it was not`);
      }
      if (negated && result) {
        fail(`Expected element ${desc} NOT to be enabled, but it was`);
      }
    },

    async toHaveText(expected, options) {
      const timeout = timeoutFor(options);
      const desc = selectorDescription(handle);
      let lastText = "";
      const result = await poll(async () => {
        try {
          const res = await handle._client.findElement(handle._selector, 0);
          if (res.found && res.element) {
            lastText = res.element.text;
            return res.element.text === expected;
          }
          return false;
        } catch {
          return false;
        }
      }, timeout);

      if (!negated && !result) {
        fail(
          `Expected element ${desc} to have text "${expected}", but got "${lastText}"`,
        );
      }
      if (negated && result) {
        fail(
          `Expected element ${desc} NOT to have text "${expected}", but it did`,
        );
      }
    },

    async toExist(options) {
      const timeout = timeoutFor(options);
      const desc = selectorDescription(handle);
      const result = await poll(async () => {
        try {
          const res = await handle._client.findElement(handle._selector, 0);
          return res.found;
        } catch {
          return false;
        }
      }, timeout);

      if (!negated && !result) {
        fail(`Expected element ${desc} to exist, but it did not`);
      }
      if (negated && result) {
        fail(`Expected element ${desc} NOT to exist, but it did`);
      }
    },

    // ─── PILOT-29: toBeChecked ───

    async toBeChecked(options) {
      const timeout = timeoutFor(options);
      const desc = selectorDescription(handle);
      const result = await poll(async () => {
        try {
          const res = await handle._client.findElement(handle._selector, 0);
          return res.found && res.element?.checked === true;
        } catch {
          return false;
        }
      }, timeout);

      if (!negated && !result) {
        fail(`Expected element ${desc} to be checked, but it was not`);
      }
      if (negated && result) {
        fail(`Expected element ${desc} NOT to be checked, but it was`);
      }
    },

    // ─── PILOT-30: toBeDisabled ───

    async toBeDisabled(options) {
      const timeout = timeoutFor(options);
      const desc = selectorDescription(handle);
      const result = await poll(async () => {
        try {
          const res = await handle._client.findElement(handle._selector, 0);
          return res.found && res.element?.enabled === false;
        } catch {
          return false;
        }
      }, timeout);

      if (!negated && !result) {
        fail(`Expected element ${desc} to be disabled, but it was not`);
      }
      if (negated && result) {
        fail(`Expected element ${desc} NOT to be disabled, but it was`);
      }
    },

    // ─── PILOT-31: toBeHidden ───

    async toBeHidden(options) {
      const timeout = timeoutFor(options);
      const desc = selectorDescription(handle);
      const result = await poll(async () => {
        try {
          const res = await handle._client.findElement(handle._selector, 0);
          return !res.found || res.element?.visible === false;
        } catch {
          return true;
        }
      }, timeout);

      if (!negated && !result) {
        fail(`Expected element ${desc} to be hidden, but it was visible`);
      }
      if (negated && result) {
        fail(`Expected element ${desc} NOT to be hidden, but it was`);
      }
    },

    // ─── PILOT-32: toBeEmpty ───

    async toBeEmpty(options) {
      const timeout = timeoutFor(options);
      const desc = selectorDescription(handle);
      let lastText = "";
      const result = await poll(async () => {
        try {
          const res = await handle._client.findElement(handle._selector, 0);
          if (res.found && res.element) {
            lastText = res.element.text;
            return !res.element.text;
          }
          return false;
        } catch {
          return false;
        }
      }, timeout);

      if (!negated && !result) {
        fail(
          `Expected element ${desc} to be empty, but it had text "${lastText}"`,
        );
      }
      if (negated && result) {
        fail(`Expected element ${desc} NOT to be empty, but it was`);
      }
    },

    // ─── PILOT-33: toBeFocused ───

    async toBeFocused(options) {
      const timeout = timeoutFor(options);
      const desc = selectorDescription(handle);
      const result = await poll(async () => {
        try {
          const res = await handle._client.findElement(handle._selector, 0);
          return res.found && res.element?.focused === true;
        } catch {
          return false;
        }
      }, timeout);

      if (!negated && !result) {
        fail(`Expected element ${desc} to be focused, but it was not`);
      }
      if (negated && result) {
        fail(`Expected element ${desc} NOT to be focused, but it was`);
      }
    },

    // ─── PILOT-34: toContainText ───

    async toContainText(expected, options) {
      const timeout = timeoutFor(options);
      const desc = selectorDescription(handle);
      let lastText = "";
      const result = await poll(async () => {
        try {
          const res = await handle._client.findElement(handle._selector, 0);
          if (res.found && res.element) {
            lastText = res.element.text;
            return matchesStringOrRegExp(res.element.text, expected);
          }
          return false;
        } catch {
          return false;
        }
      }, timeout);

      if (!negated && !result) {
        fail(
          `Expected element ${desc} to contain text ${String(expected)}, but got "${lastText}"`,
        );
      }
      if (negated && result) {
        fail(
          `Expected element ${desc} NOT to contain text ${String(expected)}, but it did`,
        );
      }
    },

    // ─── PILOT-35: toHaveCount ───

    async toHaveCount(count, options) {
      const timeout = timeoutFor(options);
      const desc = selectorDescription(handle);
      let lastCount = 0;
      const result = await poll(async () => {
        try {
          const res = await handle._client.findElements(handle._selector, 0);
          lastCount = res.elements?.length ?? 0;
          return lastCount === count;
        } catch {
          return false;
        }
      }, timeout);

      if (!negated && !result) {
        fail(
          `Expected element ${desc} to have count ${count}, but found ${lastCount}`,
        );
      }
      if (negated && result) {
        fail(`Expected element ${desc} NOT to have count ${count}, but it did`);
      }
    },

    // ─── PILOT-36: toHaveAttribute ───

    async toHaveAttribute(name, value, options) {
      const timeout = timeoutFor(options);
      const desc = selectorDescription(handle);
      let lastValue: unknown;
      const result = await poll(async () => {
        try {
          const res = await handle._client.findElement(handle._selector, 0);
          if (res.found && res.element) {
            lastValue = (res.element as unknown as Record<string, unknown>)[
              name
            ];
            return lastValue === value;
          }
          return false;
        } catch {
          return false;
        }
      }, timeout);

      if (!negated && !result) {
        fail(
          `Expected element ${desc} to have attribute "${name}" = ${JSON.stringify(value)}, but got ${JSON.stringify(lastValue)}`,
        );
      }
      if (negated && result) {
        fail(
          `Expected element ${desc} NOT to have attribute "${name}" = ${JSON.stringify(value)}, but it did`,
        );
      }
    },

    // ─── PILOT-37: toHaveAccessibleName ───

    async toHaveAccessibleName(name, options) {
      const timeout = timeoutFor(options);
      const desc = selectorDescription(handle);
      let lastName = "";
      const result = await poll(async () => {
        try {
          const res = await handle._client.findElement(handle._selector, 0);
          if (res.found && res.element) {
            // On Android, accessible name is contentDescription if set, otherwise text
            lastName = res.element.contentDescription || res.element.text;
            return matchesExact(lastName, name);
          }
          return false;
        } catch {
          return false;
        }
      }, timeout);

      if (!negated && !result) {
        fail(
          `Expected element ${desc} to have accessible name ${String(name)}, but got "${lastName}"`,
        );
      }
      if (negated && result) {
        fail(
          `Expected element ${desc} NOT to have accessible name ${String(name)}, but it did`,
        );
      }
    },

    // ─── PILOT-37: toHaveAccessibleDescription ───

    async toHaveAccessibleDescription(description, options) {
      const timeout = timeoutFor(options);
      const desc = selectorDescription(handle);
      let lastDesc = "";
      const result = await poll(async () => {
        try {
          const res = await handle._client.findElement(handle._selector, 0);
          if (res.found && res.element) {
            lastDesc = res.element.hint;
            return matchesExact(lastDesc, description);
          }
          return false;
        } catch {
          return false;
        }
      }, timeout);

      if (!negated && !result) {
        fail(
          `Expected element ${desc} to have accessible description ${String(description)}, but got "${lastDesc}"`,
        );
      }
      if (negated && result) {
        fail(
          `Expected element ${desc} NOT to have accessible description ${String(description)}, but it did`,
        );
      }
    },

    // ─── PILOT-38: toHaveRole ───

    async toHaveRole(role, options) {
      const timeout = timeoutFor(options);
      const desc = selectorDescription(handle);
      let lastRole = "";
      const result = await poll(async () => {
        try {
          const res = await handle._client.findElement(handle._selector, 0);
          if (res.found && res.element) {
            // Use the role field from the agent if available, otherwise compute from className
            lastRole =
              res.element.role || classNameToRole(res.element.className);
            return lastRole === role;
          }
          return false;
        } catch {
          return false;
        }
      }, timeout);

      if (!negated && !result) {
        fail(
          `Expected element ${desc} to have role "${role}", but got "${lastRole}"`,
        );
      }
      if (negated && result) {
        fail(`Expected element ${desc} NOT to have role "${role}", but it did`);
      }
    },

    // ─── PILOT-39: toHaveValue ───

    async toHaveValue(value, options) {
      const timeout = timeoutFor(options);
      const desc = selectorDescription(handle);
      let lastValue = "";
      const result = await poll(async () => {
        try {
          const res = await handle._client.findElement(handle._selector, 0);
          if (res.found && res.element) {
            lastValue = res.element.text;
            return res.element.text === value;
          }
          return false;
        } catch {
          return false;
        }
      }, timeout);

      if (!negated && !result) {
        fail(
          `Expected element ${desc} to have value "${value}", but got "${lastValue}"`,
        );
      }
      if (negated && result) {
        fail(
          `Expected element ${desc} NOT to have value "${value}", but it did`,
        );
      }
    },

    // ─── PILOT-40: toBeEditable ───

    async toBeEditable(options) {
      const timeout = timeoutFor(options);
      const desc = selectorDescription(handle);
      const result = await poll(async () => {
        try {
          const res = await handle._client.findElement(handle._selector, 0);
          if (res.found && res.element) {
            const isTextField =
              res.element.role === "textfield" ||
              EDITABLE_CLASSES.has(res.element.className);
            return isTextField && res.element.enabled;
          }
          return false;
        } catch {
          return false;
        }
      }, timeout);

      if (!negated && !result) {
        fail(`Expected element ${desc} to be editable, but it was not`);
      }
      if (negated && result) {
        fail(`Expected element ${desc} NOT to be editable, but it was`);
      }
    },

    // ─── PILOT-41: toBeInViewport ───

    async toBeInViewport(options) {
      const timeout = timeoutFor(options);
      const requiredRatio = options?.ratio ?? 0;
      const desc = selectorDescription(handle);
      let lastRatio = 0;
      const result = await poll(async () => {
        try {
          const res = await handle._client.findElement(handle._selector, 0);
          if (res.found && res.element) {
            lastRatio = res.element.viewportRatio ?? 0;
            if (requiredRatio > 0) {
              return lastRatio >= requiredRatio;
            }
            return lastRatio > 0;
          }
          return false;
        } catch {
          return false;
        }
      }, timeout);

      if (!negated && !result) {
        const ratioInfo =
          requiredRatio > 0 ? ` with ratio >= ${requiredRatio}` : "";
        fail(
          `Expected element ${desc} to be in viewport${ratioInfo}, but viewport ratio was ${lastRatio}`,
        );
      }
      if (negated && result) {
        fail(
          `Expected element ${desc} NOT to be in viewport, but it was (ratio: ${lastRatio})`,
        );
      }
    },
  };

  return assertions;
}

/**
 * Resolve a class name to a role using the pre-computed reverse map.
 */
function classNameToRole(className: string): string {
  return CLASS_TO_ROLE_MAP[className] || "";
}

// ─── PILOT-42: Generic value assertions ───

export interface GenericAssertions {
  /** Negate the following assertion. */
  not: GenericAssertions;

  /** Strict equality using Object.is. */
  toBe(expected: unknown): void;
  /** Deep equality. */
  toEqual(expected: unknown): void;
  /** Deep equality with type checking (no extra properties, no undefined vs missing). */
  toStrictEqual(expected: unknown): void;
  /** Assert value is truthy. */
  toBeTruthy(): void;
  /** Assert value is falsy. */
  toBeFalsy(): void;
  /** Assert value is not undefined. */
  toBeDefined(): void;
  /** Assert value is undefined. */
  toBeUndefined(): void;
  /** Assert value is null. */
  toBeNull(): void;
  /** Assert value is NaN. */
  toBeNaN(): void;
  /** Assert string/array contains item. */
  toContain(expected: unknown): void;
  /** Assert array contains an item matching deep equality. */
  toContainEqual(expected: unknown): void;
  /** Assert value has a .length property equal to expected. */
  toHaveLength(expected: number): void;
  /** Assert value has a property at the given path, optionally with a value. */
  toHaveProperty(path: string | string[], value?: unknown): void;
  /** Assert string matches a regex or string pattern. */
  toMatch(expected: string | RegExp): void;
  /** Assert object matches a subset of properties (deep). */
  toMatchObject(expected: Record<string, unknown>): void;
  /** Assert value is greater than expected. */
  toBeGreaterThan(expected: number): void;
  /** Assert value is greater than or equal to expected. */
  toBeGreaterThanOrEqual(expected: number): void;
  /** Assert value is less than expected. */
  toBeLessThan(expected: number): void;
  /** Assert value is less than or equal to expected. */
  toBeLessThanOrEqual(expected: number): void;
  /** Assert number is close to expected within precision digits. */
  toBeCloseTo(expected: number, numDigits?: number): void;
  /** Assert value is an instance of the given class. */
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  toBeInstanceOf(expected: Function): void;
  /** Assert function throws an error, optionally matching a message. */
  toThrow(expected?: string | RegExp | Error): void;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;

  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof RegExp && b instanceof RegExp) return a.toString() === b.toString();

  if (typeof a === "object" && typeof b === "object") {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;

    if (Array.isArray(aObj) !== Array.isArray(bObj)) return false;

    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) => deepEqual(aObj[key], bObj[key]));
  }
  return false;
}

function deepStrictEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;

  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof RegExp && b instanceof RegExp) return a.toString() === b.toString();

  if (typeof a === "object" && typeof b === "object") {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;

    if (Array.isArray(aObj) !== Array.isArray(bObj)) return false;
    if (aObj.constructor !== bObj.constructor) return false;

    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);
    if (aKeys.length !== bKeys.length) return false;

    // Check for undefined values explicitly (strict: {a: undefined} !== {})
    for (const key of aKeys) {
      if (!Object.prototype.hasOwnProperty.call(bObj, key)) return false;
      if (!deepStrictEqual(aObj[key], bObj[key])) return false;
    }
    return true;
  }
  return false;
}

function matchesObjectSubset(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
): boolean {
  for (const key of Object.keys(expected)) {
    if (!Object.prototype.hasOwnProperty.call(actual, key)) return false;
    const aVal = actual[key];
    const eVal = expected[key];
    if (
      typeof eVal === "object" &&
      eVal !== null &&
      !Array.isArray(eVal) &&
      typeof aVal === "object" &&
      aVal !== null &&
      !Array.isArray(aVal)
    ) {
      if (
        !matchesObjectSubset(
          aVal as Record<string, unknown>,
          eVal as Record<string, unknown>,
        )
      )
        return false;
    } else {
      if (!deepEqual(aVal, eVal)) return false;
    }
  }
  return true;
}

function getPropertyAtPath(
  obj: unknown,
  path: string | string[],
): { exists: boolean; value: unknown } {
  const parts = Array.isArray(path) ? path : path.split(".");
  let current = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return { exists: false, value: undefined };
    if (typeof current !== "object" && typeof current !== "function")
      return { exists: false, value: undefined };
    if (!Object.prototype.hasOwnProperty.call(current, part))
      return { exists: false, value: undefined };
    current = (current as Record<string, unknown>)[part];
  }
  return { exists: true, value: current };
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return `"${value}"`;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function createGenericAssertions(
  actual: unknown,
  negated: boolean,
  onFail: (message: string) => void,
): GenericAssertions {
  const assert = (pass: boolean, message: string, negMessage: string) => {
    if (!negated && !pass) onFail(message);
    if (negated && pass) onFail(negMessage);
  };

  const assertions: GenericAssertions = {
    get not(): GenericAssertions {
      return createGenericAssertions(actual, !negated, onFail);
    },

    toBe(expected) {
      assert(
        Object.is(actual, expected),
        `Expected ${formatValue(actual)} to be ${formatValue(expected)}`,
        `Expected ${formatValue(actual)} not to be ${formatValue(expected)}`,
      );
    },

    toEqual(expected) {
      assert(
        deepEqual(actual, expected),
        `Expected ${formatValue(actual)} to equal ${formatValue(expected)}`,
        `Expected ${formatValue(actual)} not to equal ${formatValue(expected)}`,
      );
    },

    toStrictEqual(expected) {
      assert(
        deepStrictEqual(actual, expected),
        `Expected ${formatValue(actual)} to strictly equal ${formatValue(expected)}`,
        `Expected ${formatValue(actual)} not to strictly equal ${formatValue(expected)}`,
      );
    },

    toBeTruthy() {
      assert(
        !!actual,
        `Expected ${formatValue(actual)} to be truthy`,
        `Expected ${formatValue(actual)} not to be truthy`,
      );
    },

    toBeFalsy() {
      assert(
        !actual,
        `Expected ${formatValue(actual)} to be falsy`,
        `Expected ${formatValue(actual)} not to be falsy`,
      );
    },

    toBeDefined() {
      assert(
        actual !== undefined,
        `Expected value to be defined, but it was undefined`,
        `Expected value to be undefined, but got ${formatValue(actual)}`,
      );
    },

    toBeUndefined() {
      assert(
        actual === undefined,
        `Expected ${formatValue(actual)} to be undefined`,
        `Expected value not to be undefined`,
      );
    },

    toBeNull() {
      assert(
        actual === null,
        `Expected ${formatValue(actual)} to be null`,
        `Expected value not to be null`,
      );
    },

    toBeNaN() {
      assert(
        Number.isNaN(actual),
        `Expected ${formatValue(actual)} to be NaN`,
        `Expected value not to be NaN`,
      );
    },

    toContain(expected) {
      let pass = false;
      if (typeof actual === "string" && typeof expected === "string") {
        pass = actual.includes(expected);
      } else if (Array.isArray(actual)) {
        pass = actual.includes(expected);
      }
      assert(
        pass,
        `Expected ${formatValue(actual)} to contain ${formatValue(expected)}`,
        `Expected ${formatValue(actual)} not to contain ${formatValue(expected)}`,
      );
    },

    toContainEqual(expected) {
      const pass = Array.isArray(actual) && actual.some((item) => deepEqual(item, expected));
      assert(
        pass,
        `Expected ${formatValue(actual)} to contain equal ${formatValue(expected)}`,
        `Expected ${formatValue(actual)} not to contain equal ${formatValue(expected)}`,
      );
    },

    toHaveLength(expected) {
      const length = (actual as { length?: number })?.length;
      assert(
        length === expected,
        `Expected length ${expected}, but got ${length}`,
        `Expected length not to be ${expected}`,
      );
    },

    toHaveProperty(path, value?) {
      const result = getPropertyAtPath(actual, path);
      if (arguments.length >= 2) {
        const pass = result.exists && deepEqual(result.value, value);
        assert(
          pass,
          `Expected property ${formatValue(path)} to be ${formatValue(value)}, but got ${formatValue(result.value)}`,
          `Expected property ${formatValue(path)} not to be ${formatValue(value)}`,
        );
      } else {
        assert(
          result.exists,
          `Expected property ${formatValue(path)} to exist`,
          `Expected property ${formatValue(path)} not to exist`,
        );
      }
    },

    toMatch(expected) {
      const str = String(actual);
      const pass =
        typeof expected === "string" ? str.includes(expected) : expected.test(str);
      assert(
        pass,
        `Expected ${formatValue(actual)} to match ${formatValue(expected)}`,
        `Expected ${formatValue(actual)} not to match ${formatValue(expected)}`,
      );
    },

    toMatchObject(expected) {
      const pass =
        typeof actual === "object" &&
        actual !== null &&
        !Array.isArray(actual) &&
        matchesObjectSubset(actual as Record<string, unknown>, expected);
      assert(
        pass,
        `Expected ${formatValue(actual)} to match object ${formatValue(expected)}`,
        `Expected ${formatValue(actual)} not to match object ${formatValue(expected)}`,
      );
    },

    toBeGreaterThan(expected) {
      assert(
        (actual as number) > expected,
        `Expected ${formatValue(actual)} to be greater than ${expected}`,
        `Expected ${formatValue(actual)} not to be greater than ${expected}`,
      );
    },

    toBeGreaterThanOrEqual(expected) {
      assert(
        (actual as number) >= expected,
        `Expected ${formatValue(actual)} to be greater than or equal to ${expected}`,
        `Expected ${formatValue(actual)} not to be greater than or equal to ${expected}`,
      );
    },

    toBeLessThan(expected) {
      assert(
        (actual as number) < expected,
        `Expected ${formatValue(actual)} to be less than ${expected}`,
        `Expected ${formatValue(actual)} not to be less than ${expected}`,
      );
    },

    toBeLessThanOrEqual(expected) {
      assert(
        (actual as number) <= expected,
        `Expected ${formatValue(actual)} to be less than or equal to ${expected}`,
        `Expected ${formatValue(actual)} not to be less than or equal to ${expected}`,
      );
    },

    toBeCloseTo(expected, numDigits = 2) {
      const precision = Math.pow(10, -numDigits) / 2;
      const pass = Math.abs((actual as number) - expected) < precision;
      assert(
        pass,
        `Expected ${formatValue(actual)} to be close to ${expected} (precision: ${numDigits} digits)`,
        `Expected ${formatValue(actual)} not to be close to ${expected} (precision: ${numDigits} digits)`,
      );
    },

    toBeInstanceOf(expected) {
      const pass = actual instanceof expected;
      assert(
        pass,
        `Expected ${formatValue(actual)} to be instance of ${expected.name}`,
        `Expected ${formatValue(actual)} not to be instance of ${expected.name}`,
      );
    },

    toThrow(expected?) {
      if (typeof actual !== "function") {
        onFail("Expected a function for toThrow()");
        return;
      }
      let threw = false;
      let thrownError: unknown;
      try {
        (actual as () => unknown)();
      } catch (e) {
        threw = true;
        thrownError = e;
      }

      if (!negated) {
        if (!threw) {
          onFail("Expected function to throw, but it did not");
          return;
        }
        if (expected !== undefined) {
          const message =
            thrownError instanceof Error ? thrownError.message : String(thrownError);
          if (typeof expected === "string") {
            if (!message.includes(expected)) {
              onFail(
                `Expected thrown error to include "${expected}", but got "${message}"`,
              );
            }
          } else if (expected instanceof RegExp) {
            if (!expected.test(message)) {
              onFail(
                `Expected thrown error to match ${expected}, but got "${message}"`,
              );
            }
          } else if (expected instanceof Error) {
            if (message !== expected.message) {
              onFail(
                `Expected thrown error message "${expected.message}", but got "${message}"`,
              );
            }
          }
        }
      } else {
        if (threw) {
          onFail(
            `Expected function not to throw, but it threw: ${thrownError instanceof Error ? thrownError.message : String(thrownError)}`,
          );
        }
      }
    },
  };

  return assertions;
}

// ─── PILOT-43: Soft assertions ───

let _softErrors: Error[] = [];

/**
 * Retrieve and clear all soft assertion failures.
 * Called by the test runner at the end of each test.
 */
export function flushSoftErrors(): Error[] {
  const errors = _softErrors;
  _softErrors = [];
  return errors;
}

function createSoftLocatorAssertions(
  handle: ElementHandle,
  negated: boolean,
): PilotAssertions {
  const inner = createAssertions(handle, negated);
  const wrapper: PilotAssertions = {} as PilotAssertions;

  Object.defineProperty(wrapper, "not", {
    get() {
      return createSoftLocatorAssertions(handle, !negated);
    },
  });

  for (const key of Object.keys(inner) as (keyof PilotAssertions)[]) {
    if (key === "not") continue;
    const original = inner[key] as (...args: unknown[]) => Promise<void>;
    (wrapper as unknown as Record<string, unknown>)[key] = async (...args: unknown[]) => {
      try {
        await original.apply(inner, args);
      } catch (err) {
        _softErrors.push(err instanceof Error ? err : new Error(String(err)));
      }
    };
  }
  return wrapper;
}

function createSoftGenericAssertions(actual: unknown, negated: boolean): GenericAssertions {
  return createGenericAssertions(actual, negated, (message) => {
    _softErrors.push(new Error(message));
  });
}

// ─── PILOT-44: Poll assertions ───

export interface PollOptions {
  timeout?: number;
  intervals?: number[];
}

function createPollAssertions(
  fn: () => unknown | Promise<unknown>,
  options: PollOptions,
): GenericAssertions {
  const timeout = options.timeout ?? DEFAULT_ASSERTION_TIMEOUT_MS;
  const intervals = options.intervals ?? [POLL_INTERVAL_MS];

  // Return a GenericAssertions where each method polls until passing
  function wrapAssertion(
    check: (value: unknown) => void,
  ): () => Promise<void> {
    return async () => {
      const deadline = Date.now() + timeout;
      let intervalIdx = 0;
      let lastError: Error | undefined;

      while (true) {
        try {
          const value = await fn();
          check(value);
          return; // Assertion passed
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
        }

        if (Date.now() >= deadline) break;

        const interval = intervals[Math.min(intervalIdx, intervals.length - 1)];
        intervalIdx++;
        await new Promise((r) => setTimeout(r, interval));
      }

      // One final attempt
      try {
        const value = await fn();
        check(value);
        return;
      } catch (err) {
        throw lastError ?? (err instanceof Error ? err : new Error(String(err)));
      }
    };
  }

  const throwOnFail = (msg: string) => {
    throw new Error(msg);
  };

  function makeGeneric(value: unknown, neg: boolean): GenericAssertions {
    return createGenericAssertions(value, neg, throwOnFail);
  }

  const buildProxy = (negated: boolean): GenericAssertions => {
    const handler: ProxyHandler<GenericAssertions> = {
      get(_target, prop: string) {
        if (prop === "not") return buildProxy(!negated);
        return (...args: unknown[]) => {
          return wrapAssertion((value) => {
            const assertions = makeGeneric(value, negated);
            const method = assertions[prop as keyof GenericAssertions];
            if (typeof method === "function") {
              (method as (...a: unknown[]) => void)(...args);
            }
          })();
        };
      },
    };
    return new Proxy({} as GenericAssertions, handler);
  };

  return buildProxy(false);
}

// ─── Main expect function ───

function isElementHandle(value: unknown): value is ElementHandle {
  return (
    value !== null &&
    typeof value === "object" &&
    "_client" in value &&
    "_selector" in value &&
    "_timeoutMs" in value
  );
}

/**
 * Create assertions for an ElementHandle or a plain value.
 *
 * - When passed an ElementHandle, returns locator assertions (auto-waiting).
 * - When passed any other value, returns generic value assertions (PILOT-42).
 */
export function expect(handle: ElementHandle): PilotAssertions;
export function expect(value: unknown): GenericAssertions;
export function expect(value: unknown): PilotAssertions | GenericAssertions {
  if (isElementHandle(value)) {
    return createAssertions(value, false);
  }
  return createGenericAssertions(value, false, (msg) => {
    throw new Error(msg);
  });
}

/**
 * Soft assertions that record failures but don't stop test execution (PILOT-43).
 */
expect.soft = function soft(value: unknown): PilotAssertions | GenericAssertions {
  if (isElementHandle(value)) {
    return createSoftLocatorAssertions(value, false);
  }
  return createSoftGenericAssertions(value, false);
} as {
  (value: ElementHandle): PilotAssertions;
  (value: unknown): GenericAssertions;
};

/**
 * Poll an async function until the assertion passes or times out (PILOT-44).
 */
expect.poll = function expectPoll(
  fn: () => unknown | Promise<unknown>,
  options?: PollOptions,
): GenericAssertions {
  return createPollAssertions(fn, options ?? {});
};
