#!/usr/bin/env node
/**
 * fetch-bezels.mjs — one-time extraction of device-frame overlay assets from
 * the bezel.fit HTTP API (https://bezel.fit).
 *
 * UI mode draws a device "bezel" around the live mirror. Instead of the
 * hand-drawn CSS bezels, the phone buckets use real photographic frames from
 * bezel.fit. bezel.fit is a compositing API (POST a screenshot → framed PNG),
 * not an asset library, so we extract a reusable *overlay* once and commit it:
 *
 *   1. POST a solid-magenta screenshot at the device's exact viewport.
 *   2. In the returned frame, the magenta region marks the screen window. Its
 *      bounding box (via ImageMagick -trim) gives the screen rect; making
 *      magenta transparent yields the overlay PNG (frame with a see-through
 *      screen). One request per device covers both.
 *   3. Downscale + compress (the mirror renders small) and write to
 *      src/ui-mode/assets/bezels/.
 *
 * The committed assets mean the API is NEVER called at runtime. Re-run this
 * script only to regenerate frames; then paste the printed metadata into
 * src/ui-mode/assets/bezels/frames.ts.
 *
 * Requirements: ImageMagick (`magick`) on PATH. Node 18+ (global fetch).
 * Usage: node scripts/fetch-bezels.mjs
 */

import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://bezel.fit';
const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(ROOT, '..', 'src', 'ui-mode', 'assets', 'bezels');

/** Phone buckets only — bezel.fit has no tablet frames (tablets fall back to CSS). */
const TARGETS = [
  { bucket: 'ios-phone', device: 'iphone-17-pro', file: 'iphone.png' },
  { bucket: 'android-phone', device: 'pixel-10-pro', file: 'android.png' },
];

/** Downscaled overlay width (px). The mirror is displayed small; keep assets light. */
const TARGET_WIDTH = 640;
/** Fuzz tolerance for isolating the (anti-aliased) magenta screen region. */
const FUZZ = '18%';
const MAGENTA = '#ff00ff';

const magick = (args) => execFileSync('magick', args, { stdio: ['ignore', 'pipe', 'inherit'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchDevices() {
  const res = await fetch(`${API}/v1/devices`);
  if (!res.ok) throw new Error(`GET /v1/devices → ${res.status}`);
  return (await res.json()).devices;
}

async function frame(device, pngPath) {
  const body = readFileSync(pngPath);
  const res = await fetch(`${API}/v1/devices/${device}/frame`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body,
  });
  if (!res.ok) {
    throw new Error(`POST /v1/devices/${device}/frame → ${res.status}: ${await res.text()}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** Bounding box "WxH+X+Y" of the magenta screen region within the framed PNG. */
function measureScreenRect(framedPath, work) {
  const mask = join(work, 'mask.png');
  // Binary mask: magenta → white, everything else → black. Match magenta with a
  // little fuzz (anti-aliased screen edge) but separate non-white at fuzz 0 so
  // the achromatic silver/black bezel never counts as screen.
  magick([framedPath, '-fuzz', FUZZ, '-fill', 'white', '-opaque', MAGENTA, '-fuzz', '0%', '-fill', 'black', '+opaque', 'white', mask]);
  // The screen is the largest white blob. Connected-components ignores the
  // stray anti-aliasing specks at the frame edges that defeat a plain -trim.
  const cc = execSync(
    `magick ${JSON.stringify(mask)} -define connected-components:verbose=true ` +
      `-define connected-components:area-threshold=50000 -connected-components 8 null: 2>&1`,
    { encoding: 'utf8' },
  );
  let best = null;
  for (const line of cc.split('\n')) {
    // "  81: 1280x2856+59+60 698.5,1487.5 3.6e+06 gray(255)"
    const m = /^\s*\d+:\s+(\d+)x(\d+)\+(\d+)\+(\d+)\s+[\d.,]+\s+([\d.e+]+)\s+gray\(255\)/.exec(line);
    if (!m) continue;
    const rect = { w: +m[1], h: +m[2], x: +m[3], y: +m[4], area: +m[5] };
    if (!best || rect.area > best.area) best = rect;
  }
  if (!best) throw new Error(`no magenta screen region found:\n${cc}`);
  return best;
}

function round(n, d = 4) {
  return Number(n.toFixed(d));
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), 'bezels-'));
  const devices = await fetchDevices();
  const meta = {};

  for (const [i, target] of TARGETS.entries()) {
    const dev = devices.find((d) => d.id === target.device);
    if (!dev) throw new Error(`device ${target.device} not in /v1/devices`);
    const { w: vw, h: vh } = dev.viewport;
    const { w: fw, h: fh } = dev.frame.size;
    console.log(`\n[${target.bucket}] ${dev.name} — viewport ${vw}×${vh}, frame ${fw}×${fh}`);

    // 1. Solid-magenta screenshot at the exact viewport (8-bit RGBA, no palette).
    const probe = join(work, `${target.device}-magenta.png`);
    magick(['-size', `${vw}x${vh}`, `xc:${MAGENTA}`, '-depth', '8', `PNG32:${probe}`]);

    // 2. Frame it.
    const framedBuf = await frame(target.device, probe);
    const framed = join(work, `${target.device}-framed.png`);
    writeFileSync(framed, framedBuf);

    // 3. Screen rect from the magenta bbox, as fractions of the frame.
    const r = measureScreenRect(framed, work);
    meta[target.bucket] = {
      file: target.file,
      frameAspect: round(fw / fh),
      screen: {
        leftPct: round(r.x / fw),
        topPct: round(r.y / fh),
        widthPct: round(r.w / fw),
        heightPct: round(r.h / fh),
      },
    };

    // 4. Overlay asset: make the magenta screen transparent, downscale, strip.
    const out = join(OUT_DIR, target.file);
    magick([
      framed,
      '-fuzz', FUZZ, '-transparent', MAGENTA,
      '-resize', `${TARGET_WIDTH}x`,
      '-strip', '-define', 'png:compression-level=9',
      `PNG32:${out}`,
    ]);
    const size = (readFileSync(out).length / 1024).toFixed(0);
    console.log(`  screen bbox ${r.w}x${r.h}+${r.x}+${r.y}  →  ${target.file} (${size} KB)`);

    // 5. Screen-opening mask: crop the overlay to the screen window and invert
    //    its alpha (opening → opaque, corners → transparent). The content is
    //    clipped to this so the rounded/squircle opening matches the bezel
    //    exactly (a circular border-radius can't).
    const maskFile = target.file.replace(/\.png$/, '-mask.png');
    const maskOut = join(OUT_DIR, maskFile);
    const [ow, oh] = magick([out, '-format', '%wx%h', 'info:']).toString().trim().split('x').map(Number);
    const s = meta[target.bucket].screen;
    const crop = `${Math.round(s.widthPct * ow)}x${Math.round(s.heightPct * oh)}+${Math.round(s.leftPct * ow)}+${Math.round(s.topPct * oh)}`;
    magick([out, '-crop', crop, '+repage', '-channel', 'A', '-negate', '+channel', '-strip', maskOut]);
    console.log(`  mask ${crop}  →  ${maskFile}`);

    // Stay under the documented 3 req / 60 s rate limit.
    if (i < TARGETS.length - 1) await sleep(25_000);
  }

  console.log('\n// ─── paste into src/ui-mode/assets/bezels/frames.ts ───');
  console.log(JSON.stringify(meta, null, 2));
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
