/**
 * Tests for when CI runs `verify-mcp-first-snapshot.mjs`: always outside pull
 * requests, and on a pull request only when it touches the guarded code.
 */
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import assert from "node:assert/strict"
import { decide, GUARDED_PATHS, isGuarded } from "../mcp-first-snapshot-paths.mjs"

test("push and workflow_dispatch always run, whatever changed", () => {
  for (const eventName of ["push", "workflow_dispatch"]) {
    assert.equal(decide({ eventName, changedFiles: ["README.md"] }).run, true)
    assert.equal(decide({ eventName, changedFiles: [] }).run, true)
  }
})

test("a PR that touches no guarded path skips the check", () => {
  const d = decide({
    eventName: "pull_request",
    changedFiles: [
      "docs/locators.md",
      "packages/tapsmith/src/expect.ts",
      "agent/src/main/kotlin/Agent.kt",
      "packages/tapsmith-core/src/android/adb.rs",
      ".github/workflows/e2e-android.yml",
      "e2e/tests/login.test.ts",
    ],
  })
  assert.equal(d.run, false)
  assert.match(d.reason, /none of the PR's 6 changed file/)
})

test("a PR touching any guarded area runs the check", () => {
  const samples = [
    "packages/tapsmith-core/src/ios/device.rs",
    "packages/tapsmith-core/src/grpc_server.rs",
    "packages/tapsmith-core/src/agent_comms.rs",
    "ios-agent/TapsmithAgent/HierarchyDumper.swift",
    "ios-agent/TapsmithAgent.xcodeproj/project.pbxproj",
    "packages/tapsmith/src/mcp/connection.ts",
    "packages/tapsmith/src/mcp/tools/snapshot.ts",
    "e2e/verify-mcp-first-snapshot.mjs",
    "e2e/utils/mcp-first-snapshot-checks.mjs",
    "e2e/utils/mcp-first-snapshot-paths.mjs",
    ".github/workflows/e2e-ios.yml",
  ]
  for (const file of samples) {
    const d = decide({ eventName: "pull_request", changedFiles: ["docs/x.md", file] })
    assert.equal(d.run, true, file)
    assert.match(d.reason, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  }
})

test("prefixes are matched as path prefixes, exact files exactly", () => {
  assert.equal(isGuarded("packages/tapsmith-core/src/ios_helper.rs"), false)
  assert.equal(isGuarded("packages/tapsmith-core/src/grpc_server.rs.bak"), false)
  assert.equal(isGuarded("ios-agent-docs/readme.md"), false)
  assert.equal(isGuarded("packages/tapsmith/src/mcp-utils.ts"), false)
  assert.equal(isGuarded(".github/workflows/e2e-ios-multi.yml"), false)
})

test("unknown changed files run the check rather than skip it", () => {
  assert.equal(decide({ eventName: "pull_request", changedFiles: null }).run, true)
})

test("every guarded path exists, so a rename can't silently drop it from the filter", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url))
  for (const p of GUARDED_PATHS) assert.ok(existsSync(join(root, p)), p)
})

test("the CLI writes run=false for a non-guarded diff and run=true for a guarded one", () => {
  const repo = mkdtempSync(join(tmpdir(), "mcp-paths-"))
  const script = fileURLToPath(new URL("../mcp-first-snapshot-paths.mjs", import.meta.url))
  const git = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim()
  try {
    git("init", "-q")
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base")
    const base = git("rev-parse", "HEAD")
    // The CLI fetches the base from origin; point origin at the repo itself.
    git("remote", "add", "origin", repo)
    const run = (file) => {
      execFileSync("mkdir", ["-p", join(repo, file, "..")])
      execFileSync("touch", [join(repo, file)])
      git("add", "-A")
      git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", file)
      const out = join(repo, `out-${Math.random()}`)
      execFileSync(process.execPath, [script], {
        cwd: repo,
        env: { ...process.env, EVENT_NAME: "pull_request", BASE_SHA: base, GITHUB_OUTPUT: out },
      })
      return readFileSync(out, "utf8").trim()
    }
    assert.equal(run("docs/a.md"), "run=false")
    assert.equal(run("ios-agent/X.swift"), "run=true")
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})
