/**
 * Assertion API for Pilot tests.
 *
 * Usage:
 *   expect(device.element(text('Hello'))).toBeVisible();
 *   expect(device.element(role('button', 'Submit'))).not.toBeEnabled();
 */

import type { ElementHandle } from "./element-handle.js";
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
  heading: ["android.widget.TextView"],
  text: [
    "android.widget.TextView",
    "androidx.appcompat.widget.AppCompatTextView",
    "com.google.android.material.textview.MaterialTextView",
  ],
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
    name: string,
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
            return !res.element.text || res.element.text === "";
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
            return matchesStringOrRegExp(lastName, name);
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
            return matchesStringOrRegExp(lastDesc, description);
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
 * Resolve a class name to a role using the role-to-class mapping.
 */
function classNameToRole(className: string): string {
  for (const [role, classes] of Object.entries(ROLE_CLASS_MAP)) {
    if (classes.includes(className)) return role;
  }
  return "";
}

/**
 * Create assertions for an ElementHandle.
 */
export function expect(handle: ElementHandle): PilotAssertions {
  return createAssertions(handle, false);
}
