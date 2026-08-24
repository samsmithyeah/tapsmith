// Reusable seed scenarios.
//
// Deliberately modelled on the repo's own e2e suite (`e2e/tests/`, `e2e/screens/`)
// so the fixtures read like a real session rather than invented placeholders.

import { fileNode, projectNode } from "./tree.js"
import type { ServerMessage, TestTreeNode } from "../../protocol.js"

export const GESTURES_FILE = "/repo/e2e/tests/gestures.test.ts"
export const HOME_FILE = "/repo/e2e/tests/home.test.ts"

/** A single file with one suite of three tests, plus one un-suited test. */
export function singleFileTree(): TestTreeNode[] {
  return [
    fileNode(GESTURES_FILE, [
      { name: "double tap registers double tap gesture", suites: ["Gestures screen"] },
      { name: "long press registers long press", suites: ["Gestures screen"] },
      { name: "swipe registers swipe", suites: ["Gestures screen"] },
      { name: "smoke" },
    ]),
  ]
}

/** A file with a nested describe, so suite nesting is exercised. */
export function nestedSuiteTree(): TestTreeNode[] {
  return [
    fileNode(HOME_FILE, [
      { name: "displays navigation cards", suites: ["Home screen"] },
      { name: "shows the count", suites: ["Home screen", "when empty"] },
      { name: "offers a retry", suites: ["Home screen", "when empty"] },
    ]),
  ]
}

/** Two files, so file-level and cross-file behaviour can be exercised. */
export function twoFileTree(): TestTreeNode[] {
  return [
    ...singleFileTree(),
    fileNode(HOME_FILE, [
      { name: "displays navigation cards", suites: ["Home screen"] },
      { name: "can scroll to see more cards", suites: ["Home screen"] },
    ]),
  ]
}

/**
 * The multi-project shape from `e2e/tapsmith.config.mjs`: the same files under
 * an android and an ios project, which is where id-prefixing matters.
 */
export function twoProjectTree(): TestTreeNode[] {
  return [
    projectNode("android", singleFileTree()),
    projectNode("ios", singleFileTree(), { dependencies: ["android"] }),
  ]
}

/** The connect-time push a client receives from a real, idle server. */
export function idleSeed(files: TestTreeNode[]): ServerMessage[] {
  return [
    { type: "test-tree", files },
    { type: "run-state", isRunning: false },
    {
      type: "device-info",
      serial: "emulator-5554",
      isEmulator: true,
      model: "sdk_gphone64_arm64",
      platform: "android",
      screenWidth: 1080,
      screenHeight: 2400,
      tapsmithVersion: "0.4.1",
    },
  ]
}
