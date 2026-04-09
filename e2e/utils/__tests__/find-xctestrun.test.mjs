import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import assert from "node:assert/strict"

// findLatestXctestrun() reads from the user's real DerivedData by default.
// Override HOME for the duration of each test so we can fake a tree.
async function withFakeHome(fn) {
  const fakeHome = mkdtempSync(join(tmpdir(), "find-xctestrun-test-"))
  const originalHome = process.env.HOME
  process.env.HOME = fakeHome
  try {
    // Fresh import each call so the helper picks up the new HOME.
    const mod = await import(`../find-xctestrun.mjs?cache=${Math.random()}`)
    await fn(fakeHome, mod.findLatestXctestrun)
  } finally {
    process.env.HOME = originalHome
    rmSync(fakeHome, { recursive: true, force: true })
  }
}

function makeXctestrun(home, hash, mtimeSeconds) {
  const dir = join(
    home,
    "Library/Developer/Xcode/DerivedData",
    `PilotAgent-${hash}`,
    "Build/Products",
  )
  mkdirSync(dir, { recursive: true })
  const path = join(dir, "PilotAgentUITests.xctestrun")
  writeFileSync(path, "fake")
  utimesSync(path, mtimeSeconds, mtimeSeconds)
  return path
}

test("returns most recently modified xctestrun when multiple exist", async () => {
  await withFakeHome((home, findLatestXctestrun) => {
    makeXctestrun(home, "older", 1_000_000)
    const newer = makeXctestrun(home, "newer", 2_000_000)

    const result = findLatestXctestrun()

    assert.equal(result, newer)
  })
})

test("returns the only match when one xctestrun exists", async () => {
  await withFakeHome((home, findLatestXctestrun) => {
    const only = makeXctestrun(home, "solo", 1_500_000)

    const result = findLatestXctestrun()

    assert.equal(result, only)
  })
})

test("throws with build instructions when no xctestrun is found", async () => {
  await withFakeHome((_home, findLatestXctestrun) => {
    assert.throws(() => findLatestXctestrun(), (err) => {
      assert.match(err.message, /No xctestrun found/)
      assert.match(err.message, /xcodebuild build-for-testing/)
      assert.match(err.message, /PILOT_IOS_XCTESTRUN/)
      return true
    })
  })
})

test("ignores non-PilotAgent DerivedData entries", async () => {
  await withFakeHome((home, findLatestXctestrun) => {
    // A sibling Xcode project's DerivedData should not be returned.
    const otherDir = join(
      home,
      "Library/Developer/Xcode/DerivedData/SomeOtherApp-abcdef/Build/Products",
    )
    mkdirSync(otherDir, { recursive: true })
    writeFileSync(join(otherDir, "Foo.xctestrun"), "fake")

    assert.throws(() => findLatestXctestrun(), /No xctestrun found/)
  })
})
