#!/usr/bin/env python3
"""Retime screencast frames into mp4 clips via ffmpeg concat demuxer."""
import json, os, subprocess

def build(frames_dir, out, segments, size='1920x1200'):
    meta = json.load(open(f'{frames_dir}/meta.json'))
    frames = meta['frames'] if isinstance(meta, dict) else meta
    marks = meta.get('marks', {}) if isinstance(meta, dict) else {}
    lines = []
    total = 0.0
    for seg in segments:
        t0, t1, cap, speed = seg
        sel = [f for f in frames if t0 <= f['t'] <= t1]
        for a, b in zip(sel, sel[1:] + [None]):
            dt = (b['t'] - a['t']) if b else 0.15
            dur = min(dt, cap) / speed
            if dur < 0.008: dur = 0.008
            lines.append(f"file '{frames_dir}/f{a['idx']:05d}.jpg'\nduration {dur:.4f}")
            total += dur
    # hold last frame
    last = lines[-1].split('\n')[0]
    lines.append(last)
    open(f'{out}.txt', 'w').write('\n'.join(lines) + '\n')
    subprocess.run(['ffmpeg', '-y', '-f', 'concat', '-safe', '0', '-i', f'{out}.txt',
                    '-vf', f'scale={size}:flags=lanczos,fps=30', '-c:v', 'libx264', '-crf', '17',
                    '-pix_fmt', 'yuv420p', '-preset', 'medium', f'{out}.mp4'],
                   check=True, capture_output=True)
    print(out, 'target-dur', round(total, 1))
    return total, marks

# Trace viewer clip: whole take, compress idles
tmeta = json.load(open('rec-frames/meta.json'))
t0, t1 = tmeta[0]['t'], tmeta[-1]['t']
build('rec-frames', 'clip-trace', [(t0, t1, 0.45, 1.5)])

# UI mode clip: two segments with a jump cut over the long run
umeta = json.load(open('ui-frames/meta.json'))
m = umeta['marks']
f0 = umeta['frames'][0]['t']
segA = (m['typing'] - 1.0, m['runClicked'] + 3.0, 0.26, 1.85)
segB = (m['passed'] - 1.5, umeta['frames'][-1]['t'], 0.38, 1.6)
build('ui-frames', 'clip-ui', [segA, segB])

for f in ['clip-trace.mp4', 'clip-ui.mp4']:
    d = subprocess.run(['ffprobe', '-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', f],
                       capture_output=True, text=True).stdout.strip()
    print(f, d)
