# Promo video pipeline

Generates `tapsmith-promo.mp4` — an ~102s promotional video (1080p30, voiceover,
music, real screen recordings of UI mode and the trace viewer, plus synthetic
scenes: a YAML-flow -> TypeScript morph with an autocomplete moment, and an
MCP-server scene showing an agent writing and running a test).

The video is defined as a deterministic timeline in **`comp.html`**
(`window.seekComp(t)` renders the exact frame for any time `t`), rendered
frame-by-frame in headless Chrome, then assembled with ffmpeg.

## Prerequisites

- **ffmpeg** (`brew install ffmpeg`)
- **Google Chrome** at `/Applications/Google Chrome.app`
- **Node 22+** — on Apple Silicon make sure `node` resolves to an **arm64**
  build (the Claude/Rosetta x64 trap breaks the UI-mode recording step; see
  the note in `record-ui` below)
- **Python 3** with a venv for audio: `python3 -m venv venv && ./venv/bin/pip install edge-tts numpy`
- `npm install` in this directory (installs `puppeteer-core`)

## Quick rebuild (no devices needed)

The checked-in `clip-ui.mp4` / `clip-trace.mp4` are the finished screen
recordings, so tweaking text, timing, scenes, or audio never touches a device:

```bash
# 1. Voiceover (only if vo/lines.txt changed)
while IFS='|' read -r n text; do
  ./venv/bin/edge-tts --voice en-US-AndrewMultilingualNeural --rate=-4% \
    --text "$text" --write-media "vo/seg$n.mp3"
done < vo/lines.txt
# (seg6, the feature list, is synthesized at --rate=+8% to fit its scene)

# 2. Music bed (deterministic synth; regenerates music.wav)
./venv/bin/python synth-music.py

# 3. Render all frames at 2x (≈10 min), or a subrange for quick edits
node render-comp.mjs full 2              # everything
node render-comp.mjs full 2 738 1315     # only the UI-mode scene, for example
node render-comp.mjs probe               # quick QC stills at key timestamps

# 4. Assemble final mp4
./assemble.sh
```

If you change VO timing or scene boundaries, keep `comp.html`'s `T` timeline,
the `adelay` values in `assemble.sh`, and the gain automation in
`synth-music.py` in sync.

## Re-recording the screen captures

Only needed if the product UI changed. Both recorders inject a synthetic
cursor + click ripples and capture via CDP screencast into `*-frames/` with
timestamps; `build-clips.py` then retimes them into 30fps clips (capping idle
gaps and jump-cutting the live test run).

**Trace viewer** (no device needed):

```bash
node server.mjs &          # serves the bundled viewer + demo-trace.zip on :4820
node record.mjs            # choreographed click-through -> rec-frames/
```

`demo-trace.zip` is a real failing gestures-test trace with the personal
filesystem path rewritten to `/Users/dev/acme-mobile`. To use a different
trace, scrub it the same way before recording (`trace.json`, `metadata.json`,
`sources.json` all contain absolute paths).

**UI mode** (boots/claims a simulator — coordinate with whoever is using it):

```bash
# Launch the UI server WITHOUT it popping a browser, and with an arm64 node
# first on PATH so tsx-forked discovery children don't hit the Rosetta/esbuild
# arch mismatch (symptom: "Discovery error" for every file, 0 discovered):
mkdir -p shim && printf '#!/bin/sh\nexit 0\n' > shim/open && chmod +x shim/open
ln -sf "$HOME/.nvm/versions/node/v22.21.0/bin/node" shim/node
cd ../../e2e && PATH="$(pwd)/../tools/promo/shim:$PATH" \
  node node_modules/.bin/tapsmith test --ui --ui-port 4830 -c tapsmith.config.ios.mjs &
cd ../tools/promo && node record-ui.mjs      # runs the network-mocking test live
python3 build-clips.py                       # rebuild clip-ui.mp4 / clip-trace.mp4
```

After rebuilding `clip-ui.mp4`, regenerate the SOURCE-row patch table: the
Call tab shows the running test file's **absolute path** (during the run it
auto-shows each action's panel, so the row appears many times at varying
heights). `detect-paths.py` scans every frame for it (continuous monospace
run in the value column reaching far right) and writes `patch-table.js`,
which `comp.html` uses to cover the row with a neutral path, frame-accurately:

```bash
./venv/bin/python detect-paths.py   # clip-ui.mp4 -> patch-table.js
node probe-s3.mjs 30 33 36 40       # spot-check stills of the patched scene
```

After every full render, run the leak sweep, which re-detects path-like rows
in the rendered S3 frames and verifies each one is covered by an active patch
run (it accounts for the scene's zoom drift and clip playback rate):

```bash
./venv/bin/python sweep-s3.py       # expect "0 uncovered path-like rows"
```

`clip-ui-session.mp4` is a full-session archive cut (near-real pacing) kept
so future re-cuts of the UI scene don't require a simulator: point
`build-clips.py` at it (or keep the raw `ui-frames/` around) instead of
re-recording.

**MCP panel** (the S3.5 scene's right-hand footage; claims the simulator):

```bash
# Restore the recording prop: the test the "agent" writes must really exist
cp api-error.test.ts.fixture ../../e2e/tests/api-error.test.ts
# Fresh server is REQUIRED — the MCP feed replays server-side history, so a
# reused server leaks old entries (including failed runs, whose result text
# contains the real trace path) into the recording.
cd ../../e2e && PATH="$(pwd)/../tools/promo/shim:$PATH" \
  node node_modules/.bin/tapsmith test --ui --ui-port 4830 --workers 1 -c tapsmith.config.ios.mjs &
cd ../tools/promo && PATH="$(pwd)/shim:$PATH" node record-mcp.mjs
python3 build-clips.py            # -> clip-mcp.mp4 (right-column crop) + session archive
rm ../../e2e/tests/api-error.test.ts
```

**Selector playground** (the S3.7 scene; claims the simulator): same server
setup as the MCP recording, then `node record-pick.mjs` — it warms the
session with a headless MCP run (set `SKIP_RUN=1` if the app is already on
the API Calls screen), toggles pick mode, hovers the mirror, and picks the
"Fetch 404" button so the Locator tab fills with generated selectors.
`probe-pick.mjs` captures the mirror-canvas rect + a screenshot for
recalibrating the hover fractions if the app layout changes.

`record-mcp.mjs` drives the choreography and spawns `mcp-client.mjs`, a real
MCP client (SDK from packages/tapsmith) that presents itself as `claude-code`
and executes `tapsmith_list_tests` / `tapsmith_run_tests` /
`tapsmith_screenshot` on cue — every feed entry in the footage is a real tool
call. A passing run's feed shows no absolute paths (verified); a FAILED run
does (trace path in the result), so if the on-camera run fails, restart the
server and re-take rather than shipping those frames.

## Files

| File | Purpose |
|---|---|
| `comp.html` | The video: scenes, animations, typed code, clips, patches, vector logo |
| `render-comp.mjs` | Frame renderer (`probe` \| `full <dsf> [from] [to]`) |
| `assemble.sh` | frames + VO + music -> `tapsmith-promo.mp4` (loudnorm -14 LUFS) |
| `record.mjs` / `record-ui.mjs` / `record-mcp.mjs` / `record-pick.mjs` | Screen-recording choreography (CDP screencast) |
| `mcp-client.mjs` | Scripted MCP client ("claude-code") driving real tool calls for the MCP take |
| `api-error.test.ts.fixture` | The test the agent "writes" on camera — copy into e2e/tests before re-recording |
| `server.mjs` | Local trace-viewer server (no browser auto-open) |
| `build-clips.py` | Screencast frames -> retimed 30fps clips (UI: setup / streaming run / results) |
| `detect-paths.py` | Scans clip-ui.mp4 for absolute-path rows -> `patch-table.js` |
| `sweep-s3.py` | Post-render leak sweep: verifies every path row in S3 is patched |
| `probe-s3.mjs` | Renders QC stills of specific timeline moments |
| `synth-music.py` | Ambient music bed (numpy, deterministic) |
| `vo/lines.txt` | Voiceover script, one line per segment |
| `assets/` | Vector mark, Poppins/JetBrains Mono woff2, screenshots |
| `clip-ui.mp4` / `clip-trace.mp4` | Finished screen-recording clips |
| `clip-ui-session.mp4` | Full UI-mode session archive (source for future re-cuts) |
| `clip-mcp.mp4` / `clip-mcp-session.mp4` / `clip-mcp-full.mp4` | MCP-panel footage (crop cut, full-frame archive, full-window intro) |
| `clip-pick.mp4` / `clip-pick-session.mp4` | Selector-playground footage (scene cut + archive) |
| `demo-trace.zip` | Scrubbed failing trace driving the trace-viewer recording |
