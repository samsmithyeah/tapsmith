#!/usr/bin/env python3
"""Verify no un-patched SOURCE path row is visible in the rendered S3 frames.

Scans every rendered frame of the UI-mode scene for path-like text rows in the
Call-tab value column (same discriminators as detect-paths.py), maps each hit
back to clip coordinates through the scene's zoom drift, and checks that an
active patch run from patch-table.js covers it. Anything uncovered is a leak.

Run after a full render:  ./venv/bin/python sweep-s3.py
"""
import json, re, subprocess
import numpy as np

# scene constants — keep in sync with comp.html
S3_T0, S3_T1 = 24.6, 43.8
UI_RATE, UI_OFF = 1.18, 0.4
VS = 1598 / 1920
F0, F1 = int(S3_T0 * 30) + 1, int(S3_T1 * 30)          # comp frames 739..1314
CX, CY, CW_, CH_ = 1100, 1560, 1280, 600               # crop in rendered (2x) px
DARK = 120

runs = json.loads(re.search(r'PATCH_RUNS = (\[.*\]);', open('patch-table.js').read()).group(1))

n = F1 - F0 + 1
subprocess.run(['ffmpeg', '-y', '-v', 'error', '-start_number', str(F0), '-i', 'comp-frames/f%05d.jpg',
                '-frames:v', str(n), '-vf', f'crop={CW_}:{CH_}:{CX}:{CY},format=gray',
                '-f', 'rawvideo', 'sweep.raw'], check=True)
data = np.fromfile('sweep.raw', dtype=np.uint8).reshape(n, CH_, CW_)

flags = []
for j in range(n):
    fi = F0 + j
    t = fi / 30
    s = 1 + 0.018 * min(1, max(0, (t - S3_T0) / (S3_T1 - S3_T0)))
    x0v, y0v = 2 * (960 - 799 * s), 2 * (540 - 476.5 * s)
    k = 2 * VS * s                                      # clip px -> rendered px
    X = lambda cx: int(x0v + cx * k) - CX
    Y = lambda cy: int(y0v + cy * k) - CY
    img = data[j]
    ys, ye = max(0, Y(900)), min(CH_, Y(1200))
    far = img[ys:ye, X(1050):X(1210)]
    left = img[ys:ye, X(535):X(685)]
    rows = np.where(((far < DARK).sum(axis=1) >= 12 * k / 2) & ((left < DARK).sum(axis=1) >= 8 * k / 2))[0]
    if len(rows) == 0:
        continue
    bands, start = [], rows[0]
    for a, b in zip(rows, rows[1:]):
        if b - a > 6: bands.append((start, a)); start = b
    bands.append((start, rows[-1]))
    clip_frame = round((t - S3_T0) * UI_RATE * 30 + UI_OFF * 30)
    active = [r for r in runs if r['f0'] <= clip_frame <= r['f1']]
    for (b0, b1) in bands:
        seg = img[ys + b0:ys + b1 + 1, X(535):X(1210)]
        cols = np.where((seg < DARK).any(axis=0))[0]
        if len(cols) < 40: continue
        if (cols[-1] - cols[0]) / k <= 500 or (np.max(np.diff(cols)) if len(cols) > 1 else 999) / k >= 30:
            continue                                     # not a continuous path-like run
        cy0 = (ys + b0 + CY - y0v) / k                   # back to clip coords
        cy1 = (ys + b1 + CY - y0v) / k
        cov = any(r['y0'] - 10 <= cy0 and cy1 <= r['y1'] + 10 for r in active)
        if not cov:
            flags.append((fi, round(cy0), round(cy1), clip_frame))

print(f'{n} frames scanned, {len(flags)} uncovered path-like rows')
for f in flags[:40]:
    print(' LEAK? frame', f[0], 'clip-y', f[1], '-', f[2], 'clipFrame', f[3])
