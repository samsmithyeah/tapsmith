import { statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { globSync } from "tinyglobby"

/**
 * Find the most recently built PilotAgent xctestrun in Xcode's DerivedData.
 *
 * The DerivedData hash changes whenever Xcode regenerates it, so hardcoding
 * the path is brittle. This walks all PilotAgent-* dirs and returns the
 * newest .xctestrun by mtime.
 *
 * Throws with build instructions if none is found.
 */
export function findLatestXctestrun() {
  const pattern = join(
    homedir(),
    "Library/Developer/Xcode/DerivedData/PilotAgent-*/Build/Products/*.xctestrun",
  )
  // Exclude `.patched.xctestrun` files left behind by previous Pilot runs.
  // Without this filter, mtime sorting eventually picks a patched file as the
  // "source" and the daemon keeps appending suffixes until the filename
  // exceeds 255 bytes and tokio::fs::copy fails.
  const matches = globSync(pattern, { absolute: true }).filter(
    (p) => !p.endsWith(".patched.xctestrun"),
  )
  if (matches.length === 0) {
    throw new Error(
      `No xctestrun found at ${pattern}\n\n` +
        `Build the iOS agent first:\n` +
        `  cd ios-agent && xcodebuild build-for-testing \\\n` +
        `    -project PilotAgent.xcodeproj -scheme PilotAgentUITests \\\n` +
        `    -destination 'platform=iOS Simulator,name=iPhone 17'\n\n` +
        `Or set PILOT_IOS_XCTESTRUN explicitly (see e2e/.env.example).`,
    )
  }
  return matches.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
}
