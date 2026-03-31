We're working on iOS support for Pilot, a mobile testing framework. The core infrastructure is built and working. The goal is to get the existing E2E suite passing on iOS without changing the test-app or E2E tests — all fixes must be framework-level.

## Current state

Branch: `ios-support`. Latest run: **~104 passed, ~26 failed, 2 skipped** (out of 134 tests) with `--trace off`.
The test app is built and installed on the "iPhone 17" simulator (iOS 26.4).
All framework components are built (TS SDK, Rust daemon, Swift agent).

Run tests with: `cd e2e && npx pilot test --config pilot.config.ios.mjs --trace off`
Run a single file: `cd e2e && npx pilot test tests/gestures.test.ts --config pilot.config.ios.mjs --trace off`

## Before starting

Read these for context:
- `CLAUDE.md` — project architecture and conventions
- The memory files at `~/.claude/projects/-Users-sam-projects-pilot/memory/` — especially `project_ios_e2e_baseline.md` (current results) and `project_ios_runloop_fix.md` (critical infrastructure context)
- `ios-agent/PilotAgent/` — the Swift XCUITest agent (SocketServer.swift, CommandHandler.swift, SnapshotElementFinder.swift, ActionExecutor.swift, QuiescenceDisabler.swift)

## Reference implementation

Maestro is cloned at `/Users/sam/projects/maestro`. Their iOS driver has solved many of the same problems. Key areas:
- Event synthesis: `maestro-ios-xctest-runner/maestro-driver-iosUITests/Routes/XCTest/EventRecord.swift`, `PointerEventPath.swift`, `RunnerDaemonProxy.swift`
- View hierarchy: `maestro-driver-iosUITests/Routes/Handlers/ViewHierarchyHandler.swift`

## Critical architecture context

The agent processes commands on the **main thread via a RunLoop-based command queue** (SocketServer.swift). This is essential — XCUITest's accessibility XPC callbacks require the main RunLoop. The socket listener runs on a background GCD queue and enqueues commands; the main RunLoop loop dequeues and processes them. Do NOT change this to use semaphores or GCD dispatch — it will cause 30-second hangs.

Event synthesis dispatch (in QuiescenceDisabler.swift) uses **RunLoop-based polling** for completion callbacks, NOT DispatchSemaphore. Semaphores block the main RunLoop and prevent XPC callbacks from firing.

After gesture actions (tap, doubleTap, longPress, swipe), a **100ms touchBarrier** lets the synthesized touch event propagate through IOKit → Simulator → App before the next command's snapshot IPC can race with it.

The `app.snapshot().dictionaryRepresentation` returns the accessibility tree in ~29ms. The snapshot does NOT contain a `traits` key. Element types for React Native components:
- `accessibilityRole="button"` → `XCUIElementTypeButton` (confirmed working)
- `accessibilityRole="checkbox"/"radio"` → `XCUIElementTypeOther` (mapped via `.other` in RoleMapping)
- Navigation cards with `accessibilityRole="link"` → `XCUIElementTypeLink`
- `testID` prop → `identifier` field in snapshot (works correctly)
- iOS strips trailing punctuation from `accessibilityLabel` (handled by `matchesIgnoringTrailingPunctuation`)

## Remaining failures to fix (priority order)

### Priority 1: Child text not accessible (~3 failures)

`text("Text inputs, buttons, focus/blur, keyboard")` and `text("Long pressed!")` can't find elements because the text is inside a parent with an explicit `accessibilityLabel` that hides children. The parent's label doesn't include the child text.

Affects: home.test.ts (1), gestures.test.ts (2 — long press state text).

Fix approach: In `findMatches`, when a node doesn't match the text selector but has children, check if any child node's `label` matches. Return the parent node if a child matches (since the child isn't separately accessible).

### Priority 2: Checkbox/radio state toggling (2 failures)

`role("checkbox", "I agree to terms")` finds the element (via `.other` type mapping) but tapping and checking `toBeChecked()` fails. The element's `checked` state might not update correctly for `.other` type elements. The element has `text: "checkbox, unchecked"` — React Native includes the role and state in the text.

Fix approach: Parse the role/state from the element's `value` or `text` field (e.g., "checkbox, checked" → checked=true). Check how Maestro reads checkbox state.

### Priority 3: Email text input drops character (1 failure)

`login.emailField.type("test@example.com")` results in `"tst@example.com"` — the `e` is dropped. iOS email keyboard autocomplete interferes with event synthesis typing. The `_XCT_sendString` API should bypass this but might not be working for all characters.

Fix approach: Check if `sendStringViaDaemon` is actually being used (vs falling through to `typeViaEventPath`). If `sendStringViaDaemon` works, the issue is elsewhere. If it fails, fix the RunLoop-based completion handling. Compare with Maestro's `_XCT_sendString` usage.

### Priority 4: Focus/keyboard detection (2 failures)

`toBeFocused()` returns false after `device.focus()`. The snapshot's `hasFocus`/`hasKeyboardFocus` keys might not be populated on Xcode 26. `hideKeyboard()` times out (31s).

Fix approach: Check what focus-related keys exist in the Xcode 26 snapshot. May need to check `hasKeyboardFocus` via XCUIElement directly instead of snapshot.

### Priority 5: Android-specific features (~14 failures)

Expected failures — pressBack, pressRecentApps, colorScheme via simctl, permissions, volume keys, clearAppData, currentActivity. Some could be implemented (sendToBackground via XCUIDevice.press(.home), colorScheme via `xcrun simctl ui`).

### Priority 6: Minor issues (~4 failures)

- `text("Select...")` — spinner placeholder text not found (spinner.test.ts)
- Snackbar dismiss timing (dialogs.test.ts)
- Delete item / loading indicator (visibility.test.ts)
- API call timing (api-calls.test.ts)

## Approach

Work through priorities 1-4 first. After each fix:
1. Rebuild the affected component (`npm run build` for TS, `cargo build --release` for Rust, `xcodebuild build-for-testing` for Swift agent)
2. **Kill the old agent** (`pkill -f PilotAgentUITests-Runner; pkill -f "xcodebuild test-without-building"`) — the agent persists across test runs and won't pick up Swift changes otherwise
3. Run the specific affected test file with `--trace off` to verify
4. Commit when a priority is resolved
5. **Avoid running the full suite** — run only the specific test files affected by each change

## Rules

- Do NOT modify files in `test-app/` or `e2e/`
- All fixes go in `ios-agent/`, `packages/pilot-core/`, or `packages/pilot/`
- Always rebuild before testing — the TS runner uses compiled JS from `dist/`
- When making changes to the Swift agent, rebuild with:
  ```
  cd ios-agent && xcodebuild build-for-testing \
    -project PilotAgent.xcodeproj \
    -scheme PilotAgentUITests \
    -destination 'platform=iOS Simulator,name=iPhone 17'
  ```
- After rebuilding the Swift agent, **kill the old agent processes** before running tests
- After rebuilding the Rust daemon, **kill the old daemon** (`pkill -f pilot-core`)
