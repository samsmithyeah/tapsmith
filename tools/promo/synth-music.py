#!/usr/bin/env python3
"""Ambient promo bed: warm pad progression + soft arp, with scene-aware gain automation."""
import numpy as np
import wave

SR = 44100
DUR = 89.0
N = int(SR * DUR)
t = np.arange(N) / SR
mix = np.zeros(N)

def note_hz(midi):
    return 440.0 * 2 ** ((midi - 69) / 12)

def pad_note(midi, start, dur, amp):
    """Warm additive pad voice with slow attack/release."""
    n0, n1 = int(start * SR), min(int((start + dur) * SR), N)
    if n1 <= n0: return
    seg = np.arange(n1 - n0) / SR
    f = note_hz(midi)
    # slight detune pair + harmonics, gentle vibrato
    vib = 1 + 0.0015 * np.sin(2 * np.pi * 0.7 * seg + midi)
    w = (np.sin(2 * np.pi * f * 0.9985 * seg * vib) +
         np.sin(2 * np.pi * f * 1.0015 * seg) +
         0.45 * np.sin(2 * np.pi * 2 * f * seg) +
         0.12 * np.sin(2 * np.pi * 3 * f * seg))
    atk = min(1.2, dur * 0.4); rel = min(1.6, dur * 0.45)
    env = np.minimum(1, seg / atk) * np.minimum(1, (dur - seg) / rel)
    env = np.clip(env, 0, 1) ** 1.5
    mix[n0:n1] += amp * w * env

def pluck(midi, start, amp):
    """Soft sine pluck with fast decay."""
    dur = 0.5
    n0, n1 = int(start * SR), min(int((start + dur) * SR), N)
    if n1 <= n0: return
    seg = np.arange(n1 - n0) / SR
    f = note_hz(midi)
    w = np.sin(2 * np.pi * f * seg) + 0.3 * np.sin(2 * np.pi * 2 * f * seg)
    env = np.exp(-seg * 9) * np.minimum(1, seg / 0.004)
    mix[n0:n1] += amp * w * env

# Progression: Am7 - Fmaj7 - Cmaj7 - G6 (rooted low), 4s per chord, loops for 85s
chords = [
    [45, 57, 60, 64, 67],   # A1(root A2 sub), A3 C4 E4 G4
    [41, 53, 57, 60, 65],   # F
    [36, 55, 59, 60, 64],   # C
    [43, 55, 59, 62, 67],   # G
]
CH = 4.0
i = 0
start = 0.0
while start < DUR:
    ch = chords[i % 4]
    # sub root
    pad_note(ch[0], start, CH + 1.5, 0.16)
    for m in ch[1:]:
        pad_note(m, start, CH + 1.5, 0.075)
    i += 1
    start += CH

# Arp plucks during the demo scenes (24s..73s): eighth notes over chord tones
rng = np.random.default_rng(7)
tt = 24.6
while tt < 70.6:
    ci = int(tt // CH) % 4
    tones = chords[ci][1:] + [chords[ci][2] + 12]
    m = tones[rng.integers(0, len(tones))]
    pluck(m + 12, tt, 0.045 + 0.015 * rng.random())
    tt += 0.5

# Riser/whoosh at scene boundaries: filtered noise swell
def swell(center, width, amp):
    n0, n1 = max(0, int((center - width) * SR)), min(N, int((center + width * 0.4) * SR))
    if n1 <= n0: return
    seg = np.arange(n1 - n0)
    noise = rng.standard_normal(n1 - n0)
    # cheap lowpass: cumulative smoothing
    k = 40
    kern = np.hanning(k); kern /= kern.sum()
    noise = np.convolve(noise, kern, mode='same')
    x = seg / (n1 - n0)
    env = np.sin(np.pi * np.clip(x, 0, 1)) ** 2
    mix[n0:n1] += amp * noise * env

for b in [4.4, 24.6, 43.8, 57.8, 70.6, 82.4]:
    swell(b, 1.4, 0.10)

# Gain automation: intro forward, ducked under VO, swell at outro, fade out
auto = np.ones(N)
def seg_gain(t0, t1, g0, g1):
    n0, n1 = int(t0 * SR), min(int(t1 * SR), N)
    if n1 <= n0: return
    auto[n0:n1] = np.linspace(g0, g1, n1 - n0)

seg_gain(0, 0.9, 0.55, 0.95)
seg_gain(0.9, 1.4, 0.95, 0.42)     # duck for VO1 (starts 1.3)
seg_gain(1.4, 84.5, 0.42, 0.42)
seg_gain(84.5, 85.5, 0.42, 0.6)    # gentle lift under the closing line
seg_gain(85.5, 87.8, 0.6, 0.55)
seg_gain(87.8, 89.0, 0.55, 0.0)    # fade out
mix *= auto

# gentle master soft-clip + normalize
mix = np.tanh(mix * 1.4)
mix *= 0.7 / np.max(np.abs(mix))

pcm = (mix * 32767).astype('<i2')
stereo = np.repeat(pcm[:, None], 2, axis=1)
with wave.open('music.wav', 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes(stereo.tobytes())
print('music.wav written', DUR, 's')
