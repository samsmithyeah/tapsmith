/**
 * Content checks for a trace archive recorded against a real device.
 *
 * Split from `verify-trace-archive.mjs` (which drives the traced run) so the
 * checks themselves are unit-testable without a device — see
 * `__tests__/trace-archive-checks.test.mjs`. A check that can never fail is
 * worse than no check, so the ones that depend on the trace containing
 * particular material assert that they found material to work with.
 */

import * as fs from "node:fs"
import { unzipSync } from "fflate"

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
/** Smallest plausible real device screen edge, in pixels. */
const MIN_SCREEN_EDGE = 200

// ─── Archive reading ───

/** Parse a trace archive into the shape the checks below work on. */
export function readArchive(zipPath) {
  const files = unzipSync(new Uint8Array(fs.readFileSync(zipPath)))
  const text = (name) => new TextDecoder().decode(files[name])
  const ndjson = (name) =>
    files[name] ? text(name).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []
  const events = ndjson("trace.json")
  return {
    files,
    metadata: files["metadata.json"] ? JSON.parse(text("metadata.json")) : {},
    events,
    // Actions and assertions both occupy a slot in the action-index space and
    // can own captures.
    steps: events.filter((e) => e.type === "action" || e.type === "assertion"),
    network: ndjson("network.json"),
  }
}

/** Width/height from a PNG's IHDR chunk, or null if it isn't a PNG. */
function pngSize(bytes) {
  const buf = Buffer.from(bytes)
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_MAGIC)) return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

/**
 * The human-readable name a selector matched on, if it has one that should
 * appear verbatim in a hierarchy dump. Returns null otherwise.
 */
function selectorName(serialized) {
  if (typeof serialized !== "string") return null
  let selector
  try {
    selector = JSON.parse(serialized)
  } catch {
    return null
  }
  const candidate =
    selector.text ??
    selector.textContains ??
    selector.contentDesc ??
    selector.label ??
    selector.hint ??
    selector.role?.name
  return typeof candidate === "string" && candidate.length >= 3 ? candidate : null
}

const pad = (index) => String(index).padStart(3, "0")
const screenshotMember = (index) => `screenshots/action-${pad(index)}-before.png`
const hierarchyMember = (index) => `hierarchy/action-${pad(index)}-before.xml`

// ─── Checks ───

/** Collects failures and notes so one run reports every problem, not just the first. */
class Report {
  failures = []
  notes = []

  check(ok, message, detail) {
    if (ok) return true
    this.failures.push(detail ? `${message}\n      ${detail}` : message)
    return false
  }

  note(message) {
    this.notes.push(message)
  }
}

function checkMetadata(archive, r) {
  const m = archive.metadata
  r.check(m.version === 1, `metadata.version should be 1, got ${m.version}`)
  r.check(m.testStatus === "passed", `metadata.testStatus should be "passed", got "${m.testStatus}"`)
  r.check(!!m.testName, "metadata.testName is empty")
  r.check(!!m.tapsmithVersion, "metadata.tapsmithVersion is empty")
  r.check(m.actionCount > 0, `metadata.actionCount should be > 0, got ${m.actionCount}`)
  r.check(
    Number.isFinite(m.startTime) && Number.isFinite(m.endTime) && m.endTime >= m.startTime,
    `metadata timestamps are not a valid range: ${m.startTime} → ${m.endTime}`,
  )

  // Device identity has to come off the real device, not the placeholder the
  // runner falls back to when it has no serial.
  r.check(
    !!m.device?.serial && m.device.serial !== "unknown",
    `metadata.device.serial should name the device under test, got "${m.device?.serial}"`,
  )
  // Enrichment comes from a `listDevices` lookup; which fields a platform
  // fills in varies, so require that it resolved *something* rather than
  // pinning a field the daemon may not report for a given target.
  r.check(
    !!m.device?.osVersion || !!m.device?.model,
    "metadata.device has neither model nor osVersion — device enrichment resolved nothing",
  )
  r.note(
    `device: ${m.device?.serial} (${m.device?.model ?? "unknown model"}, ` +
      `os ${m.device?.osVersion ?? "?"}${m.device?.isEmulator ? ", emulator" : ""})`,
  )

  // Without these the checks below would pass on an archive that recorded
  // nothing at all.
  for (const channel of ["screenshots", "snapshots", "network"]) {
    r.check(
      m.traceConfig?.[channel] === true,
      `trace.${channel} was not enabled — the run did not record what these checks verify`,
    )
  }
}

function checkEventStream(archive, r) {
  const { steps, metadata } = archive
  if (!r.check(steps.length > 0, "trace.json contains no action or assertion events")) return

  // One index space, filled contiguously from 0. The viewer's step navigation
  // and every capture filename depend on it.
  const indices = steps.map((s) => s.actionIndex)
  r.check(
    JSON.stringify(indices) === JSON.stringify(steps.map((_, i) => i)),
    "action indices are not contiguous from 0",
    `got [${indices.join(", ")}]`,
  )
  r.check(
    metadata.actionCount === steps.length,
    `metadata.actionCount (${metadata.actionCount}) should equal the recorded step count (${steps.length})`,
  )

  const outOfOrder = steps.findIndex((s, i) => i > 0 && s.timestamp < steps[i - 1].timestamp)
  r.check(outOfOrder === -1, `step ${outOfOrder} has a timestamp before its predecessor`)

  r.check(
    steps.some((s) => s.type === "action" && s.success),
    "no successful action was recorded",
  )
  r.note(
    `${steps.length} steps: ${steps.filter((s) => s.type === "action").length} actions, ` +
      `${steps.filter((s) => s.type === "assertion").length} assertions`,
  )
}

function checkScreenshots(archive, r) {
  const members = Object.keys(archive.files).filter((f) => f.startsWith("screenshots/")).sort()
  if (!r.check(members.length > 0, "the archive contains no screenshots")) return

  for (const step of archive.steps) {
    if (!step.hasScreenshotBefore) continue
    r.check(
      screenshotMember(step.actionIndex) in archive.files,
      `step ${step.actionIndex} (${step.action ?? step.assertion}) claims a screenshot but ` +
        `${screenshotMember(step.actionIndex)} is missing`,
    )
  }

  // Nothing stored that no step claims — except the single trailing
  // terminal-state capture the runner takes past the last action, so the viewer
  // has an "after" view for it.
  const unclaimed = members.filter((member) => {
    const index = Number(/action-(\d+)-/.exec(member)?.[1])
    return index !== archive.metadata.actionCount && !archive.steps[index]?.hasScreenshotBefore
  })
  r.check(unclaimed.length === 0, `screenshot members no step claims: ${unclaimed.join(", ")}`)

  // That trailing capture is not optional: the viewer reads the *next* step's
  // before-shot as a step's "after" view, so without it the last step has no
  // after view at all. The runner takes it whenever the screenshots channel is
  // on (which checkMetadata already required), best-effort — so a missing one
  // means the capture RPC failed and the run reported success anyway.
  r.check(
    screenshotMember(archive.metadata.actionCount) in archive.files,
    `no terminal-state screenshot: ${screenshotMember(archive.metadata.actionCount)} is missing, ` +
      "so the last step has no \"after\" view",
  )

  // screenshotCount is what the viewer and `tapsmith_read_trace` report. The
  // packager skips a capture whose temp file it cannot read, so a count above
  // the members present is silent data loss.
  r.check(
    archive.metadata.screenshotCount === members.length,
    `metadata.screenshotCount (${archive.metadata.screenshotCount}) does not match the ` +
      `${members.length} screenshot member(s) in the archive`,
  )

  // Real frames: decodable PNGs, all at one plausible screen size.
  const sizes = new Set()
  const digests = new Set()
  for (const member of members) {
    const size = pngSize(archive.files[member])
    if (!r.check(size !== null, `${member} is not a PNG`)) continue
    r.check(
      size.width >= MIN_SCREEN_EDGE && size.height >= MIN_SCREEN_EDGE,
      `${member} is ${size.width}x${size.height} — too small to be a device screenshot`,
    )
    sizes.add(`${size.width}x${size.height}`)
    digests.add(Buffer.from(archive.files[member]).toString("base64"))
  }
  r.check(sizes.size <= 1, `screenshots disagree on screen size: ${[...sizes].join(", ")}`)
  // The driven test navigates, taps, and renders a response, so the captures
  // cannot all be the same frame — that would mean stale or cached captures.
  r.check(
    members.length < 2 || digests.size > 1,
    `all ${members.length} screenshots are byte-identical — captures are not tracking the screen`,
  )
  r.note(
    `${members.length} screenshots at ${[...sizes].join(", ") || "no size"}, ${digests.size} distinct`,
  )

  // Element bounds are recorded in logical points and screenshots in pixels,
  // so a box must fit inside the frame at any device pixel ratio. A degenerate
  // or out-of-frame box means the two coordinate spaces disagree.
  const [frame] = [...sizes]
  if (!frame) return
  const [frameWidth, frameHeight] = frame.split("x").map(Number)
  let checkedBoxes = 0
  for (const step of archive.steps) {
    const b = step.bounds
    if (!b) continue
    checkedBoxes++
    r.check(
      b.right > b.left && b.bottom > b.top,
      `step ${step.actionIndex} recorded a degenerate element box ` +
        `[${b.left},${b.top}][${b.right},${b.bottom}]`,
    )
    r.check(
      b.left >= 0 && b.top >= 0 && b.right <= frameWidth && b.bottom <= frameHeight,
      `step ${step.actionIndex} recorded an element box outside the ${frame} frame: ` +
        `[${b.left},${b.top}][${b.right},${b.bottom}]`,
    )
  }
  r.note(`${checkedBoxes} element boxes checked against the ${frame} frame`)
}

function checkHierarchies(archive, r) {
  const members = Object.keys(archive.files).filter((f) => f.startsWith("hierarchy/")).sort()
  if (!r.check(members.length > 0, "the archive contains no hierarchy snapshots")) return

  // The runner's trailing terminal-state capture takes a hierarchy dump too
  // whenever the snapshots channel is on, so the Hierarchy tab has something to
  // show for the last step. (The trailing capture as a whole is gated on the
  // screenshots channel; checkMetadata required both.)
  r.check(
    hierarchyMember(archive.metadata.actionCount) in archive.files,
    `no terminal-state hierarchy snapshot: ${hierarchyMember(archive.metadata.actionCount)} ` +
      "is missing, so the last step has no post-action dump",
  )

  for (const step of archive.steps) {
    if (!step.hasHierarchyBefore) continue
    r.check(
      hierarchyMember(step.actionIndex) in archive.files,
      `step ${step.actionIndex} claims a hierarchy snapshot but ` +
        `${hierarchyMember(step.actionIndex)} is missing`,
    )
  }

  for (const member of members) {
    const xml = new TextDecoder().decode(archive.files[member])
    r.check(xml.trimStart().startsWith("<"), `${member} does not start with an XML tag`)
    // Android dumps <node …>; iOS dumps XCUIElementType* elements.
    r.check(
      /<node[\s>]/.test(xml) || /XCUIElementType/.test(xml),
      `${member} holds no recognisable UI nodes`,
      xml.slice(0, 120),
    )
    r.check(
      (xml.match(/</g) ?? []).length === (xml.match(/>/g) ?? []).length,
      `${member} has unbalanced angle brackets — the dump looks truncated`,
    )
  }

  // The strongest real-device check available: an action resolves its target
  // before its snapshot is taken, so the name it matched on must be present in
  // the snapshot filed under that action's own index. This fails if captures
  // are paired with the wrong step, or if a dump is stale for its action.
  //
  // Only actions qualify. An auto-waiting assertion captures *before* it polls
  // — by design, so the trace shows the screen the wait started from — so its
  // target legitimately may not be on screen yet.
  let verifiedPairings = 0
  for (const step of archive.steps) {
    if (step.type !== "action" || !step.hasHierarchyBefore) continue
    const needle = selectorName(step.selector)
    if (needle === null) continue
    const xml = new TextDecoder().decode(
      archive.files[hierarchyMember(step.actionIndex)] ?? new Uint8Array(),
    )
    if (
      r.check(
        xml.includes(needle),
        `action ${step.actionIndex} (${step.action}) resolved an element named "${needle}", but ` +
          `its own hierarchy snapshot (${hierarchyMember(step.actionIndex)}) does not contain it`,
      )
    ) {
      verifiedPairings++
    }
  }
  r.check(
    verifiedPairings > 0,
    "no action recorded a named selector, so capture/step pairing could not be cross-checked " +
      "against real device data",
  )
  r.note(
    `${members.length} hierarchy snapshots, ${verifiedPairings} cross-checked against ` +
      "their action's selector",
  )
}

function checkNetwork(archive, r) {
  const entries = archive.network
  if (
    !r.check(
      entries.length > 0,
      "network.json is missing or empty — the app's traffic was not captured",
    )
  ) {
    return
  }

  const indices = entries.map((e) => e.index)
  r.check(
    JSON.stringify(indices) === JSON.stringify(entries.map((_, i) => i)),
    `network entry indices are not contiguous from 0: [${indices.join(", ")}]`,
  )
  for (const entry of entries) {
    r.check(
      !("requestBody" in entry) && !("responseBody" in entry),
      `network entry ${entry.index} serialized its transient body buffers into network.json`,
    )
    r.check(
      Number.isInteger(entry.actionIndex) &&
        entry.actionIndex >= 0 &&
        entry.actionIndex < Math.max(archive.metadata.actionCount, 1),
      `network entry ${entry.index} is attributed to step ${entry.actionIndex}, outside the recorded steps`,
    )
    for (const key of ["requestBodyPath", "responseBodyPath"]) {
      if (!entry[key]) continue
      r.check(
        entry[key] in archive.files,
        `network entry ${entry.index} points at ${entry[key]}, which is not in the archive`,
      )
    }
  }

  // The app's own HTTPS call must be there, with a real response.
  const https = entries.filter((e) => typeof e.url === "string" && e.url.startsWith("https://"))
  r.check(https.length > 0, `no https:// entry captured; urls were ${entries.map((e) => e.url).join(", ")}`)
  const answered = https.filter((e) => e.status >= 200 && e.status < 400 && e.responseBodyPath)
  if (r.check(answered.length > 0, "no https entry captured a successful response with a body")) {
    // A captured JSON body must be stored decoded — the daemon sees gzipped,
    // chunk-framed wire bytes and the Network tab renders what is in the
    // archive.
    const jsonEntry = answered.find((e) => (e.contentType ?? "").includes("json"))
    if (jsonEntry) {
      const body = new TextDecoder().decode(archive.files[jsonEntry.responseBodyPath])
      let parsed = false
      try {
        JSON.parse(body)
        parsed = true
      } catch { /* reported below */ }
      r.check(
        parsed,
        `${jsonEntry.url} declared ${jsonEntry.contentType} but its stored body is not JSON ` +
          "(still compressed or chunk-framed?)",
        body.slice(0, 120),
      )
    }
  }
  r.note(
    `${entries.length} network entries, ${https.length} https, ` +
      `${entries.filter((e) => e.responseBodyPath).length} with response bodies`,
  )
}

/**
 * Run every content check against a parsed archive.
 *
 * @returns `{ failures, notes }` — `failures` empty means the archive holds
 *   everything a real-device trace should.
 */
export function checkArchive(archive) {
  const r = new Report()
  checkMetadata(archive, r)
  checkEventStream(archive, r)
  checkScreenshots(archive, r)
  checkHierarchies(archive, r)
  checkNetwork(archive, r)
  return { failures: r.failures, notes: r.notes }
}
