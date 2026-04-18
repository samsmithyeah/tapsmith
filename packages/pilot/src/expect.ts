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

import { ElementHandle } from "./element-handle.js";
import type { ElementInfo } from "./grpc-client.js";
import { selectorToProto } from "./selectors.js";
import { extractSourceLocation, getActiveTraceCollector } from "./trace/trace-collector.js";

const DEFAULT_ASSERTION_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 250;
// Short server-side timeout for element lookups inside assertion polls.
// Must be > 0 because the Rust daemon treats 0 as "use 30s default".
// 100ms was too aggressive under multi-emulator load and produced false
// negatives where the UI was visibly present but the lookup timed out.
const POLL_FIND_TIMEOUT_MS = 500;

/**
 * Repeatedly call `check` until it returns the expected value or the timeout
 * is exceeded.
 *
 * @param negated When true, the poll succeeds as soon as `check` returns
 *   `false` — used for negated assertions (`.not.toBeVisible()` etc.) so they
 *   don't burn the entire timeout when the condition is already not met.
 * @returns The raw `check()` result on the final attempt (callers compare this
 *   against `negated` to decide pass/fail).
 */
async function poll(
  check: () => Promise<boolean>,
  timeoutMs: number,
  negated = false,
): Promise<boolean> {
  const target = !negated; // true = want check() to be true; false = want false
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value === target) return value;
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
  searchfield: [
    "android.widget.SearchView",
    "androidx.appcompat.widget.SearchView",
    // RN renders accessibilityRole="search" as a normal EditText with the
    // searchfield trait/role description; include it so toHaveRole and
    // role-derived className matching agree.
    "android.widget.EditText",
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

/**
 * Wrap an assertion method to emit trace events when tracing is active.
 */
function wrapAssertionWithTrace(
  name: string,
  fn: (...args: unknown[]) => Promise<void>,
  handle: ElementHandle,
  negated: boolean,
): (...args: unknown[]) => Promise<void> {
  const trace = handle._traceCapture;
  if (!trace) return fn;

  return async (...args: unknown[]) => {
    const sourceLocation = extractSourceLocation(new Error().stack ?? "");
    const selectorStr = selectorDescription(handle);
    const start = Date.now();

    // Capture before-screenshot (bounds lookup happens after the assertion
    // so the element is guaranteed to exist and be stable).
    const { captures: beforeCaptures } = await trace.collector.captureBeforeAction(
      trace.takeScreenshot,
      trace.captureHierarchy,
    );

    let passed = true;
    let error: string | undefined;
    let caughtErr: unknown;

    // Local flag set by the fail handler — immune to interleaving from other actions
    let failedByTimeout = false;

    // Register pending operation so the runner can emit a failed event on timeout
    trace.collector.setPendingOperation((timeoutError: string) => {
      failedByTimeout = true;
      trace.collector.addAssertionEvent({
        assertion: (negated ? "not." : "") + name,
        selector: selectorStr,
        passed: false,
        soft: false,
        negated,
        duration: Date.now() - start,
        attempts: Math.max(1, Math.round((Date.now() - start) / POLL_INTERVAL_MS)),
        error: timeoutError,
        sourceLocation,
        hasScreenshotBefore: !!beforeCaptures.screenshotBefore,
        hasScreenshotAfter: false,
        hasHierarchyBefore: !!beforeCaptures.hierarchyBefore,
        hasHierarchyAfter: false,
      } as Parameters<typeof trace.collector.addAssertionEvent>[0]);
    });

    try {
      await fn(...args);
    } catch (err) {
      passed = false;
      error = err instanceof Error ? err.message : String(err);
      caughtErr = err;
    }

    trace.collector.clearPendingOperation();

    // If the runner's timeout already emitted a failed event, skip the normal emit
    if (failedByTimeout) {
      if (caughtErr !== undefined) throw caughtErr;
      return;
    }

    // Snapshot duration before async capture so it reflects the actual
    // assertion time, not assertion + screenshot overhead.
    const duration = Date.now() - start;
    const attempts = Math.max(1, Math.round(duration / POLL_INTERVAL_MS));

    // Look up element bounds after assertion completes — the element is
    // guaranteed to exist (for passing assertions) and the screen is stable.
    let bounds: { left: number; top: number; right: number; bottom: number } | undefined;
    if (passed) {
      try {
        const res = await handle._client.findElement(handle._selector, 100);
        if (res.found && res.element?.bounds) {
          bounds = res.element.bounds;
        }
      } catch { /* best-effort */ }
    }

    // Emit event immediately so _actionIndex increments before the runner
    // emits group-end boundaries.  No after-capture — the trace viewer uses
    // the next action's before-screenshot as the "after" view.
    trace.collector.addAssertionEvent({
      assertion: (negated ? "not." : "") + name,
      selector: selectorStr,
      passed,
      soft: false,
      negated,
      duration,
      attempts,
      error,
      bounds,
      sourceLocation,
      hasScreenshotBefore: !!beforeCaptures.screenshotBefore,
      hasScreenshotAfter: false,
      hasHierarchyBefore: !!beforeCaptures.hierarchyBefore,
      hasHierarchyAfter: false,
    } as Parameters<typeof trace.collector.addAssertionEvent>[0]);

    if (caughtErr !== undefined) {
      throw caughtErr;
    }
  };
}

function createAssertions(
  handle: ElementHandle,
  negated: boolean,
): PilotAssertions {
  const timeoutFor = (opts?: { timeout?: number }) =>
    opts?.timeout ?? handle._timeoutMs ?? DEFAULT_ASSERTION_TIMEOUT_MS;

  const fail = (message: string, callsite?: Error): never => {
    const err = new Error(message);
    // Replace the stack so the top frame points to the test file (where the
    // assertion was called) rather than to Pilot internals.
    const source = callsite ?? err;
    if (source.stack) {
      const frames = source.stack.split('\n').slice(1);
      // Move user frames (non-Pilot-internal) to the top so the test file
      // location is the first thing developers see.
      const isInternal = (line: string) =>
        line.includes('/packages/pilot/') ||
        line.includes('node:internal/');
      const userFrames = frames.filter((l) => !isInternal(l));
      const internalFrames = frames.filter((l) => isInternal(l));
      const reordered = [...userFrames, ...internalFrames];
      err.stack = `Error: ${message}\n${reordered.join('\n')}`;
    }
    throw err;
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
          const res = await handle._client.findElement(handle._selector, POLL_FIND_TIMEOUT_MS);
          return res.found && res.element?.visible === true;
        } catch {
          return false;
        }
      }, timeout, negated);

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
          const res = await handle._client.findElement(handle._selector, POLL_FIND_TIMEOUT_MS);
          return res.found && res.element?.enabled === true;
        } catch {
          return false;
        }
      }, timeout, negated);

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
          const res = await handle._client.findElement(handle._selector, POLL_FIND_TIMEOUT_MS);
          if (res.found && res.element) {
            lastText = res.element.text;
            return res.element.text === expected;
          }
          return false;
        } catch {
          return false;
        }
      }, timeout, negated);

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
          const res = await handle._client.findElement(handle._selector, POLL_FIND_TIMEOUT_MS);
          return res.found;
        } catch {
          return false;
        }
      }, timeout, negated);

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
          const res = await handle._client.findElement(handle._selector, POLL_FIND_TIMEOUT_MS);
          return res.found && res.element?.checked === true;
        } catch {
          return false;
        }
      }, timeout, negated);

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
          const res = await handle._client.findElement(handle._selector, POLL_FIND_TIMEOUT_MS);
          return res.found && res.element?.enabled === false;
        } catch {
          return false;
        }
      }, timeout, negated);

      if (!negated && !result) {
        fail(`Expected element ${desc} to be disabled, but it was not`);
      }
      if (negated && result) {
        fail(`Expected element ${desc} NOT to be disabled, but it was`);
      }
    },

    // ─── PILOT-31: toBeHidden ───
    // Note: check() returns true when hidden. With `.not.toBeHidden()`,
    // negated=true makes poll succeed when check returns false (= visible).

    async toBeHidden(options) {
      const timeout = timeoutFor(options);
      const desc = selectorDescription(handle);
      const result = await poll(async () => {
        try {
          const res = await handle._client.findElement(handle._selector, POLL_FIND_TIMEOUT_MS);
          return !res.found || res.element?.visible === false;
        } catch {
          return true;
        }
      }, timeout, negated);

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
          const res = await handle._client.findElement(handle._selector, POLL_FIND_TIMEOUT_MS);
          if (res.found && res.element) {
            lastText = res.element.text;
            return !res.element.text;
          }
          return false;
        } catch {
          return false;
        }
      }, timeout, negated);

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
          const res = await handle._client.findElement(handle._selector, POLL_FIND_TIMEOUT_MS);
          return res.found && res.element?.focused === true;
        } catch {
          return false;
        }
      }, timeout, negated);

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
          const res = await handle._client.findElement(handle._selector, POLL_FIND_TIMEOUT_MS);
          if (res.found && res.element) {
            lastText = res.element.text;
            return matchesStringOrRegExp(res.element.text, expected);
          }
          return false;
        } catch {
          return false;
        }
      }, timeout, negated);

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
          const res = await handle._client.findElements(handle._selector, POLL_FIND_TIMEOUT_MS);
          lastCount = res.elements?.length ?? 0;
          return lastCount === count;
        } catch {
          return false;
        }
      }, timeout, negated);

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
          const res = await handle._client.findElement(handle._selector, POLL_FIND_TIMEOUT_MS);
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
      }, timeout, negated);

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
          const res = await handle._client.findElement(handle._selector, POLL_FIND_TIMEOUT_MS);
          if (res.found && res.element) {
            // On Android, accessible name is contentDescription if set, otherwise text
            lastName = res.element.contentDescription || res.element.text;
            return matchesExact(lastName, name);
          }
          return false;
        } catch {
          return false;
        }
      }, timeout, negated);

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
          const res = await handle._client.findElement(handle._selector, POLL_FIND_TIMEOUT_MS);
          if (res.found && res.element) {
            lastDesc = res.element.hint;
            return matchesExact(lastDesc, description);
          }
          return false;
        } catch {
          return false;
        }
      }, timeout, negated);

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
      const expected = normalizeRole(role);
      let lastRole = "";
      const result = await poll(async () => {
        try {
          const res = await handle._client.findElement(handle._selector, POLL_FIND_TIMEOUT_MS);
          if (res.found && res.element) {
            // Use the role field from the agent if available, otherwise compute from className
            lastRole =
              res.element.role || classNameToRole(res.element.className);
            return normalizeRole(lastRole) === expected;
          }
          return false;
        } catch {
          return false;
        }
      }, timeout, negated);

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
          const res = await handle._client.findElement(handle._selector, POLL_FIND_TIMEOUT_MS);
          if (res.found && res.element) {
            lastValue = res.element.text;
            return res.element.text === value;
          }
          return false;
        } catch {
          return false;
        }
      }, timeout, negated);

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
          const res = await handle._client.findElement(handle._selector, POLL_FIND_TIMEOUT_MS);
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
      }, timeout, negated);

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
          const res = await handle._client.findElement(handle._selector, POLL_FIND_TIMEOUT_MS);
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
      }, timeout, negated);

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

  // Wrap with tracing if active
  if (handle._traceCapture) {
    const traced: PilotAssertions = {
      get not(): PilotAssertions {
        return createAssertions(handle, !negated);
      },
    } as PilotAssertions;

    for (const key of Object.keys(assertions) as (keyof PilotAssertions)[]) {
      if (key === "not") continue;
      const original = assertions[key] as (...args: unknown[]) => Promise<void>;
      (traced as unknown as Record<string, unknown>)[key] =
        wrapAssertionWithTrace(key, original.bind(assertions), handle, negated);
    }
    return traced;
  }

  return assertions;
}

/**
 * Resolve a class name to a role using the pre-computed reverse map.
 */
function classNameToRole(className: string): string {
  return CLASS_TO_ROLE_MAP[className] || "";
}

/**
 * Cross-platform role aliases. Lets `toHaveRole("header")` succeed when the
 * agent reports "heading" (and vice versa), and similarly for "slider" /
 * "seekbar". Mirrors the alias map in agent's ElementFinder.kt.
 */
const ROLE_ALIASES: Record<string, string> = {
  header: "heading",
  heading: "heading",
  slider: "seekbar",
  seekbar: "seekbar",
};

function normalizeRole(role: string): string {
  const lower = role.toLowerCase();
  return ROLE_ALIASES[lower] ?? lower;
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
  function _deepEqual(a: unknown, b: unknown, visited: Map<unknown, unknown>): boolean {
    if (Object.is(a, b)) return true;
    if (a === null || b === null) return false;
    if (typeof a !== typeof b) return false;

    if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
    if (a instanceof RegExp && b instanceof RegExp) return a.toString() === b.toString();

    if (typeof a === "object" && typeof b === "object") {
      if (visited.has(a) && visited.get(a) === b) return true;
      visited.set(a, b);

      const aObj = a as Record<string, unknown>;
      const bObj = b as Record<string, unknown>;

      if (Array.isArray(aObj) !== Array.isArray(bObj)) return false;

      const aKeys = Object.keys(aObj);
      const bKeys = Object.keys(bObj);
      if (aKeys.length !== bKeys.length) return false;

      for (const key of aKeys) {
        if (
          !Object.prototype.hasOwnProperty.call(bObj, key) ||
          !_deepEqual(aObj[key], bObj[key], visited)
        ) {
          return false;
        }
      }
      return true;
    }
    return false;
  }
  return _deepEqual(a, b, new Map());
}

function deepStrictEqual(a: unknown, b: unknown): boolean {
  function _deepStrictEqual(a: unknown, b: unknown, visited: Map<unknown, unknown>): boolean {
    if (Object.is(a, b)) return true;
    if (a === null || b === null) return false;
    if (typeof a !== typeof b) return false;

    if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
    if (a instanceof RegExp && b instanceof RegExp) return a.toString() === b.toString();

    if (typeof a === "object" && typeof b === "object") {
      if (visited.has(a) && visited.get(a) === b) return true;
      visited.set(a, b);

      const aObj = a as Record<string, unknown>;
      const bObj = b as Record<string, unknown>;

      if (Array.isArray(aObj) !== Array.isArray(bObj)) return false;
      if (aObj.constructor !== bObj.constructor) return false;

      const aKeys = Object.keys(aObj);
      const bKeys = Object.keys(bObj);
      if (aKeys.length !== bKeys.length) return false;

      for (const key of aKeys) {
        if (!Object.prototype.hasOwnProperty.call(bObj, key)) return false;
        if (!_deepStrictEqual(aObj[key], bObj[key], visited)) return false;
      }
      return true;
    }
    return false;
  }
  return _deepStrictEqual(a, b, new Map());
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchesObjectSubset(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
): boolean {
  for (const key of Object.keys(expected)) {
    if (!Object.prototype.hasOwnProperty.call(actual, key)) return false;
    const aVal = actual[key];
    const eVal = expected[key];
    if (isPlainObject(eVal) && isPlainObject(aVal)) {
      if (!matchesObjectSubset(aVal, eVal)) return false;
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
  if (typeof value === "object") {
    if (value === null) return "null";
    try {
      return JSON.stringify(value);
    } catch {
      return "[Circular Object]";
    }
  }
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

  /** Emit a trace event for a generic value assertion. */
  const trace = (name: string, pass: boolean, expected?: unknown) => {
    const collector = getActiveTraceCollector();
    if (!collector) return;
    const finalPass = negated ? !pass : pass;
    collector.addAssertionEvent({
      assertion: (negated ? 'not.' : '') + name,
      passed: finalPass,
      soft: false,
      negated,
      duration: 0,
      attempts: 1,
      expected: expected !== undefined ? formatValue(expected) : undefined,
      actual: formatValue(actual),
      error: finalPass ? undefined : `Expected ${formatValue(actual)} ${negated ? 'not ' : ''}${name}${expected !== undefined ? ' ' + formatValue(expected) : ''}`,
      sourceLocation: extractSourceLocation(new Error().stack ?? ''),
    });
  };

  const assertions: GenericAssertions = {
    get not(): GenericAssertions {
      return createGenericAssertions(actual, !negated, onFail);
    },

    toBe(expected) {
      const pass = Object.is(actual, expected);
      trace('toBe', pass, expected);
      assert(pass, `Expected ${formatValue(actual)} to be ${formatValue(expected)}`, `Expected ${formatValue(actual)} not to be ${formatValue(expected)}`);
    },

    toEqual(expected) {
      const pass = deepEqual(actual, expected);
      trace('toEqual', pass, expected);
      assert(pass, `Expected ${formatValue(actual)} to equal ${formatValue(expected)}`, `Expected ${formatValue(actual)} not to equal ${formatValue(expected)}`);
    },

    toStrictEqual(expected) {
      const pass = deepStrictEqual(actual, expected);
      trace('toStrictEqual', pass, expected);
      assert(pass, `Expected ${formatValue(actual)} to strictly equal ${formatValue(expected)}`, `Expected ${formatValue(actual)} not to strictly equal ${formatValue(expected)}`);
    },

    toBeTruthy() {
      const pass = !!actual;
      trace('toBeTruthy', pass);
      assert(pass, `Expected ${formatValue(actual)} to be truthy`, `Expected ${formatValue(actual)} not to be truthy`);
    },

    toBeFalsy() {
      const pass = !actual;
      trace('toBeFalsy', pass);
      assert(pass, `Expected ${formatValue(actual)} to be falsy`, `Expected ${formatValue(actual)} not to be falsy`);
    },

    toBeDefined() {
      const pass = actual !== undefined;
      trace('toBeDefined', pass);
      assert(pass, `Expected value to be defined, but it was undefined`, `Expected value to be undefined, but got ${formatValue(actual)}`);
    },

    toBeUndefined() {
      const pass = actual === undefined;
      trace('toBeUndefined', pass);
      assert(pass, `Expected ${formatValue(actual)} to be undefined`, `Expected value not to be undefined`);
    },

    toBeNull() {
      const pass = actual === null;
      trace('toBeNull', pass);
      assert(pass, `Expected ${formatValue(actual)} to be null`, `Expected value not to be null`);
    },

    toBeNaN() {
      const pass = Number.isNaN(actual);
      trace('toBeNaN', pass);
      assert(pass, `Expected ${formatValue(actual)} to be NaN`, `Expected value not to be NaN`);
    },

    toContain(expected) {
      let pass = false;
      if (typeof actual === "string" && typeof expected === "string") {
        pass = actual.includes(expected);
      } else if (Array.isArray(actual)) {
        pass = actual.includes(expected);
      }
      trace('toContain', pass, expected);
      assert(pass, `Expected ${formatValue(actual)} to contain ${formatValue(expected)}`, `Expected ${formatValue(actual)} not to contain ${formatValue(expected)}`);
    },

    toContainEqual(expected) {
      const pass = Array.isArray(actual) && actual.some((item) => deepEqual(item, expected));
      trace('toContainEqual', pass, expected);
      assert(pass, `Expected ${formatValue(actual)} to contain equal ${formatValue(expected)}`, `Expected ${formatValue(actual)} not to contain equal ${formatValue(expected)}`);
    },

    toHaveLength(expected) {
      const length = (actual as { length?: number })?.length;
      const pass = length === expected;
      trace('toHaveLength', pass, expected);
      assert(pass, `Expected length ${expected}, but got ${length}`, `Expected length not to be ${expected}`);
    },

    toHaveProperty(path, value?) {
      const result = getPropertyAtPath(actual, path);
      if (arguments.length >= 2) {
        const pass = result.exists && deepEqual(result.value, value);
        trace('toHaveProperty', pass, value);
        assert(pass, `Expected property ${formatValue(path)} to be ${formatValue(value)}, but got ${formatValue(result.value)}`, `Expected property ${formatValue(path)} not to be ${formatValue(value)}`);
      } else {
        trace('toHaveProperty', result.exists, path);
        assert(result.exists, `Expected property ${formatValue(path)} to exist`, `Expected property ${formatValue(path)} not to exist`);
      }
    },

    toMatch(expected) {
      const str = String(actual);
      const pass = typeof expected === "string" ? str.includes(expected) : expected.test(str);
      trace('toMatch', pass, expected);
      assert(pass, `Expected ${formatValue(actual)} to match ${formatValue(expected)}`, `Expected ${formatValue(actual)} not to match ${formatValue(expected)}`);
    },

    toMatchObject(expected) {
      const pass = isPlainObject(actual) && matchesObjectSubset(actual, expected);
      trace('toMatchObject', pass, expected);
      assert(pass, `Expected ${formatValue(actual)} to match object ${formatValue(expected)}`, `Expected ${formatValue(actual)} not to match object ${formatValue(expected)}`);
    },

    toBeGreaterThan(expected) {
      if (typeof actual !== "number") {
        onFail(`Expected a number for toBeGreaterThan but got ${typeof actual}: ${formatValue(actual)}`);
        return;
      }
      const pass = actual > expected;
      trace('toBeGreaterThan', pass, expected);
      assert(pass, `Expected ${formatValue(actual)} to be greater than ${expected}`, `Expected ${formatValue(actual)} not to be greater than ${expected}`);
    },

    toBeGreaterThanOrEqual(expected) {
      if (typeof actual !== "number") {
        onFail(`Expected a number for toBeGreaterThanOrEqual but got ${typeof actual}: ${formatValue(actual)}`);
        return;
      }
      const pass = actual >= expected;
      trace('toBeGreaterThanOrEqual', pass, expected);
      assert(pass, `Expected ${formatValue(actual)} to be greater than or equal to ${expected}`, `Expected ${formatValue(actual)} not to be greater than or equal to ${expected}`);
    },

    toBeLessThan(expected) {
      if (typeof actual !== "number") {
        onFail(`Expected a number for toBeLessThan but got ${typeof actual}: ${formatValue(actual)}`);
        return;
      }
      const pass = actual < expected;
      trace('toBeLessThan', pass, expected);
      assert(pass, `Expected ${formatValue(actual)} to be less than ${expected}`,
        `Expected ${formatValue(actual)} not to be less than ${expected}`,
      );
    },

    toBeLessThanOrEqual(expected) {
      if (typeof actual !== "number") {
        onFail(`Expected a number for toBeLessThanOrEqual but got ${typeof actual}: ${formatValue(actual)}`);
        return;
      }
      const pass = actual <= expected;
      trace('toBeLessThanOrEqual', pass, expected);
      assert(pass, `Expected ${formatValue(actual)} to be less than or equal to ${expected}`, `Expected ${formatValue(actual)} not to be less than or equal to ${expected}`);
    },

    toBeCloseTo(expected, numDigits = 2) {
      if (typeof actual !== "number") {
        onFail(`Expected a number for toBeCloseTo but got ${typeof actual}: ${formatValue(actual)}`);
        return;
      }
      const precision = Math.pow(10, -numDigits) / 2;
      const pass = Math.abs(actual - expected) < precision;
      trace('toBeCloseTo', pass, expected);
      assert(pass, `Expected ${formatValue(actual)} to be close to ${expected} (precision: ${numDigits} digits)`, `Expected ${formatValue(actual)} not to be close to ${expected} (precision: ${numDigits} digits)`);
    },

    toBeInstanceOf(expected) {
      const pass = actual instanceof expected;
      trace('toBeInstanceOf', pass);
      assert(pass, `Expected ${formatValue(actual)} to be instance of ${expected.name}`, `Expected ${formatValue(actual)} not to be instance of ${expected.name}`);
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
      trace('toThrow', negated ? !threw : threw, expected);

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
        if (!threw) return;

        if (expected === undefined) {
          onFail(
            `Expected function not to throw, but it threw: ${thrownError instanceof Error ? thrownError.message : String(thrownError)}`,
          );
          return;
        }

        // .not.toThrow(expected) fails only if the thrown error matches
        const message =
          thrownError instanceof Error ? thrownError.message : String(thrownError);
        let matches = false;
        if (typeof expected === "string") {
          matches = message.includes(expected);
        } else if (expected instanceof RegExp) {
          matches = expected.test(message);
        } else if (expected instanceof Error) {
          matches = message === expected.message;
        }

        if (matches) {
          onFail(
            `Expected function not to throw error matching ${formatValue(expected)}`,
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

      while (true) {
        try {
          const value = await fn();
          check(value);
          return; // Assertion passed
        } catch (err) {
          if (process.env.PILOT_DEBUG) {
            console.log(`[pilot.poll] Intermediate error: ${err instanceof Error ? err.message : String(err)}`);
          }
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
        throw err instanceof Error ? err : new Error(String(err));
      }
    };
  }

  const throwOnFail = (msg: string) => {
    throw new Error(msg);
  };

  function makeGeneric(value: unknown, neg: boolean): GenericAssertions {
    return createGenericAssertions(value, neg, throwOnFail);
  }

  // Build a set of valid method names for eager validation
  const validMethods = new Set(
    Object.keys(createGenericAssertions(null, false, () => {})).filter(
      (k) => k !== "not",
    ),
  );

  const buildProxy = (negated: boolean): GenericAssertions => {
    const handler: ProxyHandler<GenericAssertions> = {
      get(_target, prop: string) {
        if (prop === "not") return buildProxy(!negated);
        if (prop === "then") return undefined; // Support await
        if (!validMethods.has(prop)) {
          return () =>
            Promise.reject(
              new Error(
                `expect.poll(): "${prop}" is not a valid assertion method`,
              ),
            );
        }
        return (...args: unknown[]) => {
          return wrapAssertion((value) => {
            const assertions = makeGeneric(value, negated);
            (assertions[prop as keyof GenericAssertions] as (...a: unknown[]) => void)(...args);
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
  return value instanceof ElementHandle;
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
