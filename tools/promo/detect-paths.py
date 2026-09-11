#!/usr/bin/env python3
"""Scan clip-ui.mp4 for Call-tab SOURCE rows showing an absolute path, and emit
patch-table.js for comp.html.

A SOURCE row is the only value in the bottom detail panel long enough to reach
x>=1050 (clip coords, 1920x1200): the absolute test-file path. For every frame
we find contiguous dark-text row bands in that far-right column slice, merge
them into time runs, and assign each run a stable plausible line number so the
replacement text never flickers within a panel.

Run after rebuilding a clip:  ./venv/bin/python detect-paths.py [ui|multi]
(ui -> patch-table.js / PATCH_RUNS, multi -> patch-table-multi.js / PATCH_RUNS_MULTI).
Both recordings share the 1600x1000 UI-mode layout, so the row geometry is
the same; only the replacement texts differ.
"""
import json, subprocess, sys
import numpy as np

CLIP = sys.argv[1] if len(sys.argv) > 1 else 'ui'
CLIPS = {
    # first panel is the beforeEach deep-link reset (app-reset.ts); later
    # panels walk down the test file
    'ui': dict(src='clip-ui.mp4', out='patch-table.js', var='PATCH_RUNS',
               first='/Users/dev/acme-mobile/e2e/utils/app-reset.ts:26',
               rest='/Users/dev/acme-mobile/e2e/tests/network-mocking.test.ts:{}',
               lines=[84, 85, 87, 89, 91, 93, 95, 97, 103]),
    # every action in the chat test goes through the ChatScreen screen object
    'multi': dict(src='clip-multi.mp4', out='patch-table-multi.js', var='PATCH_RUNS_MULTI',
                  first='/Users/dev/acme-mobile/e2e/screens/chat.screen.ts:22',
                  rest='/Users/dev/acme-mobile/e2e/screens/chat.screen.ts:{}',
                  lines=[26, 30, 34, 38, 41, 45, 47, 30, 34, 41, 47, 52]),
}[CLIP]

X0, Y0, W, H = 400, 900, 810, 300      # scanned region, clip coords
SLICE = (650, 810)                     # x-slice rel to X0 == clip 1050..1210
GAP = (40, 125)                        # clip 440..525: blank between a SOURCE label and its value;
                                       # source-code lines (Source tab) have text here
DARK, MIN_DARK, FPS = 120, 12, 30

subprocess.run(['ffmpeg', '-y', '-v', 'error', '-i', CLIPS['src'],
                '-vf', f'crop={W}:{H}:{X0}:{Y0},format=gray', '-f', 'rawvideo', 'scan.raw'],
               check=True)
data = np.fromfile('scan.raw', dtype=np.uint8)
n = len(data) // (W * H)
frames = data[:n*W*H].reshape(n, H, W)

per_frame = []                          # frame -> (y0, y1) in clip coords, or None
for i in range(n):
    col = frames[i][:, SLICE[0]:SLICE[1]]
    left = frames[i][:, 135:285]     # value column start (clip x 535-685):
    gap = frames[i][:, GAP[0]:GAP[1]]
    # a real SOURCE path is dark both here and far right, with nothing in the
    # label/value gap; long URLs, UI chrome rows and Source-tab code lines are not.
    rows = np.where(((col < DARK).sum(axis=1) >= MIN_DARK)
                    & ((left < DARK).sum(axis=1) >= 8)
                    & ((gap < DARK).sum(axis=1) <= 1))[0]
    if len(rows) == 0:
        per_frame.append(None)
        continue
    # take the largest contiguous band
    bands, start = [], rows[0]
    for a, b in zip(rows, rows[1:]):
        if b - a > 4:
            bands.append((start, a)); start = b
    bands.append((start, rows[-1]))
    # keep only bands whose text is one continuous monospace run spanning the
    # value column (a path); table rows have >=40px inter-column gaps.
    def is_path(y0, y1):
        seg = frames[i][y0:y1+1, 135:]         # clip x 535..1210
        dark_cols = np.where((seg < DARK).any(axis=0))[0]
        if len(dark_cols) < 40: return False
        span = dark_cols[-1] - dark_cols[0]
        maxgap = int(np.max(np.diff(dark_cols))) if len(dark_cols) > 1 else 999
        return span > 500 and maxgap < 30
    bands = [b for b in bands if is_path(*b)]
    per_frame.append([(int(y0)+Y0, int(y1)+Y0) for y0, y1 in bands] or None)

# merge into runs (same band within 8px, gaps <= 4 frames); a frame can
# contribute to two concurrent runs during panel transitions
runs = []
for i, bands_i in enumerate(per_frame):
    if bands_i is None: continue
    for band in bands_i:
        hit = next((r for r in reversed(runs)
                    if i - r['f1'] <= 4 and abs(band[0] - r['y0']) <= 8), None)
        if hit:
            hit['f1'] = i
            hit['y0'] = min(hit['y0'], band[0])
            hit['y1'] = max(hit['y1'], band[1])
        else:
            runs.append({'f0': i, 'f1': i, 'y0': band[0], 'y1': band[1]})
runs.sort(key=lambda r: r['f0'])

# pad bands to cover full glyph extent incl. antialiasing
for r in runs:
    r['y0'] -= 7
    r['y1'] += 9

# stable replacement text per run (never flickers within a panel)
LINES = CLIPS['lines']
li = 0
for k, r in enumerate(runs):
    if k == 0:
        r['text'] = CLIPS['first']
    else:
        r['text'] = CLIPS['rest'].format(LINES[min(li, len(LINES)-1)])
        li += 1
    # dilate one frame each side where free
    prev_end = runs[k-1]['f1'] if k else -10
    next_start = runs[k+1]['f0'] if k+1 < len(runs) else n+10
    if r['f0'] - 1 > prev_end: r['f0'] -= 1
    if r['f1'] + 1 < next_start: r['f1'] += 1

open(CLIPS['out'], 'w').write(
    f"// generated by detect-paths.py — SOURCE-row patch windows for {CLIPS['src']}\n"
    f"window.{CLIPS['var']} = {json.dumps(runs)};\n")
print(f'{n} frames, {len(runs)} runs')
for r in runs:
    print(f"  f{r['f0']}-{r['f1']} ({r['f0']/FPS:.2f}-{r['f1']/FPS:.2f}s) y{r['y0']}-{r['y1']} {r['text'].split('/')[-1]}")
