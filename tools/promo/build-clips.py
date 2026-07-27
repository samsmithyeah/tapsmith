#!/usr/bin/env python3
"""Retime screencast frames into mp4 clips via ffmpeg concat demuxer.

Builds whichever clips have source frames present:
  rec-frames/ -> clip-trace.mp4
  ui-frames/  -> clip-ui.mp4 (3 segments: setup, compressed run with actions
                 streaming in one by one, results exploration)
              -> clip-ui-session.mp4 (full session, lightly retimed archive
                 so future re-cuts don't require a simulator)
"""
import json, os, subprocess

def build(frames_dir, out, segments, size='1920x1200'):
    meta = json.load(open(f'{frames_dir}/meta.json'))
    frames = meta['frames'] if isinstance(meta, dict) else meta
    lines = []
    total = 0.0
    for t0, t1, cap, speed in segments:
        sel = [f for f in frames if t0 <= f['t'] <= t1]
        acc = 0.0
        for a, b in zip(sel, sel[1:] + [None]):
            dt = (b['t'] - a['t']) if b else 0.15
            acc += min(dt, cap) / speed
            # decimate: only emit once enough retimed time has accumulated
            if acc < 1 / 45: continue
            lines.append(f"file '{frames_dir}/f{a['idx']:05d}.jpg'\nduration {acc:.4f}")
            total += acc
            acc = 0.0
    last = lines[-1].split('\n')[0]
    lines.append(last)
    open(f'{out}.txt', 'w').write('\n'.join(lines) + '\n')
    subprocess.run(['ffmpeg', '-y', '-f', 'concat', '-safe', '0', '-i', f'{out}.txt',
                    '-vf', f'scale={size}:flags=lanczos,fps=30', '-c:v', 'libx264', '-crf', '17',
                    '-pix_fmt', 'yuv420p', '-preset', 'medium', f'{out}.mp4'],
                   check=True, capture_output=True)
    d = subprocess.run(['ffprobe', '-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', f'{out}.mp4'],
                       capture_output=True, text=True).stdout.strip()
    print(f'{out}.mp4 {float(d):.2f}s (target {total:.2f}s)')
    return total

if os.path.exists('rec-frames/meta.json'):
    tmeta = json.load(open('rec-frames/meta.json'))
    t0, t1 = tmeta[0]['t'], tmeta[-1]['t']
    build('rec-frames', 'clip-trace', [(t0, t1, 0.45, 1.5)])

if os.path.exists('ui-frames/meta.json'):
    umeta = json.load(open('ui-frames/meta.json'))
    m = umeta['marks']
    tend = umeta['frames'][-1]['t']
    # Three segments; total must stay ~23.6s so the comp timeline (S3 spans
    # 24.0-46.8 with 0.4s lead-in) is unchanged.
    segA = (m['typing'] - 1.0, m['runClicked'] + 1.5, 0.26, 3.35)
    segM = (m['runClicked'] + 1.5, m['passed'] - 1.2, 0.45, 8.1)   # actions stream in
    segB = (m['passed'] - 1.2, tend, 0.38, 2.05)
    build('ui-frames', 'clip-ui', [segA, segM, segB])
    # Archive: whole session, near-real pacing with idle gaps capped.
    build('ui-frames', 'clip-ui-session', [(umeta['frames'][0]['t'], tend, 0.6, 1.0)])
