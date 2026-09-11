#!/usr/bin/env python3
"""Ambient promo bed: warm pad progression + soft arp, with scene-aware gain automation.

Shape: a thin, unresolved two-chord bed under the problem section, a near-silent
rest under "Tapsmith is the next step.", then a resolving chord hit with a low
thump on BEAT — the arp and full progression run from there. Keep BEAT and the
scene boundaries in sync with comp.html (BEAT, T) and assemble.sh (adelay).
"""
import numpy as np
import wave

SR = 44100
DUR = 131.9
BEAT = 17.0
SCENES = [4.4, 31.7, 50.9, 62.1, 75.1, 92.1, 109.1, 125.3]   # scene boundaries after the beat scene
N = int(SR * DUR)
t = np.arange(N) / SR
mix = np.zeros(N)

def note_hz(midi):
    return 440.0 * 2 ** ((midi - 69) / 12)

def pad_note(midi, start, dur, amp, atk=None):
    """Warm additive pad voice with slow attack/release (atk overrides the attack)."""
    n0, n1 = int(start * SR), min(int((start + dur) * SR), N)
    if n1 <= n0 or n0 < 0: return
    seg = np.arange(n1 - n0) / SR
    f = note_hz(midi)
    # slight detune pair + harmonics, gentle vibrato
    vib = 1 + 0.0015 * np.sin(2 * np.pi * 0.7 * seg + midi)
    w = (np.sin(2 * np.pi * f * 0.9985 * seg * vib) +
         np.sin(2 * np.pi * f * 1.0015 * seg) +
         0.45 * np.sin(2 * np.pi * 2 * f * seg) +
         0.12 * np.sin(2 * np.pi * 3 * f * seg))
    a = atk if atk is not None else min(1.2, dur * 0.4)
    rel = min(1.6, dur * 0.45)
    env = np.minimum(1, seg / a) * np.minimum(1, (dur - seg) / rel)
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

def thump(start, amp):
    """Low sine impact with a soft transient — the hit under the beat."""
    dur = 0.9
    n0, n1 = int(start * SR), min(int((start + dur) * SR), N)
    seg = np.arange(n1 - n0) / SR
    f = 52.0 * (1 + 0.6 * np.exp(-seg * 18))          # slight downward pitch sweep
    ph = 2 * np.pi * np.cumsum(f) / SR
    body = np.sin(ph) * np.exp(-seg * 4.2)
    click = np.random.default_rng(3).standard_normal(n1 - n0) * np.exp(-seg * 90) * 0.35
    mix[n0:n1] += amp * (body + click) * np.minimum(1, seg / 0.003)

# Progression: Am7 - Fmaj7 - Cmaj7 - G6 (rooted low), 4s per chord, grid aligned
# so a chord starts exactly on BEAT.
chords = [
    [45, 57, 60, 64, 67],   # A1(root A2 sub), A3 C4 E4 G4
    [41, 53, 57, 60, 65],   # F
    [36, 55, 59, 60, 64],   # C
    [43, 55, 59, 62, 67],   # G
]
CH = 4.0
start = BEAT - CH * int(BEAT // CH + 1)
i = 0
while start < DUR:
    if start < BEAT - 1e-6:
        # cold bed: only Am / F alternating, root + one voice, unresolved
        ch = chords[i % 2]
        pad_note(ch[0], start, CH + 1.5, 0.13)
        pad_note(ch[2], start, CH + 1.5, 0.05)
    else:
        # from the beat: full voicing, progression resumes at the resolving Cmaj7
        k = int(round((start - BEAT) / CH))   # bars since the beat
        ch = chords[(2 + k) % 4]
        if abs(start - BEAT) < 1e-6:
            # the hit: fast attack, every voice plus an octave-up shimmer
            pad_note(ch[0], start, CH + 1.5, 0.19, atk=0.02)
            for m in ch[1:]:
                pad_note(m, start, CH + 1.5, 0.085, atk=0.03)
            pad_note(ch[3] + 12, start, 2.5, 0.05, atk=0.02)
            thump(start, 0.55)
        else:
            pad_note(ch[0], start, CH + 1.5, 0.16)
            for m in ch[1:]:
                pad_note(m, start, CH + 1.5, 0.075)
    i += 1
    start += CH

# Arp plucks from the beat through the demo scenes: eighth notes over chord tones
rng = np.random.default_rng(7)
tt = BEAT + 0.5
while tt < SCENES[-2]:
    k = int((tt - BEAT) // CH)
    ci = (2 + k) % 4
    tones = chords[ci][1:] + [chords[ci][2] + 12]
    m = tones[rng.integers(0, len(tones))]
    # a touch louder right after the hit, settling over the first bars
    boost = 1.0 + 0.6 * max(0.0, 1 - (tt - BEAT) / 6.0)
    pluck(m + 12, tt, (0.045 + 0.015 * rng.random()) * boost)
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

for b in SCENES:
    swell(b, 1.4, 0.10)
swell(BEAT, 1.0, 0.16)   # riser into the hit (ends just past it)

# Gain automation: intro forward, ducked under VO, the rest before the beat,
# the hit forward, swell at outro, fade out
auto = np.ones(N)
def seg_gain(t0, t1, g0, g1):
    n0, n1 = int(t0 * SR), min(int(t1 * SR), N)
    if n1 <= n0: return
    auto[n0:n1] = np.linspace(g0, g1, n1 - n0)

seg_gain(0, 0.5, 0.55, 0.9)
seg_gain(0.5, 0.9, 0.9, 0.42)                 # duck for VO1 (starts 0.6)
seg_gain(1.4, BEAT - 2.3, 0.42, 0.42)
seg_gain(BEAT - 2.3, BEAT - 1.9, 0.42, 0.05)  # the rest: VO1 has just ended, 2a speaks into near-silence
seg_gain(BEAT - 1.9, BEAT - 0.6, 0.05, 0.05)
seg_gain(BEAT - 0.6, BEAT, 0.05, 0.75)        # riser opens up into the hit
seg_gain(BEAT, BEAT + 0.6, 0.75, 0.62)
seg_gain(BEAT + 0.6, BEAT + 2.2, 0.62, 0.42)  # settle under VO 2b
seg_gain(BEAT + 2.2, DUR - 4.5, 0.42, 0.42)
seg_gain(DUR - 4.5, DUR - 3.5, 0.42, 0.6)     # gentle lift under the closing line
seg_gain(DUR - 3.5, DUR - 1.2, 0.6, 0.55)
seg_gain(DUR - 1.2, DUR, 0.55, 0.0)           # fade out
mix *= auto

# gentle master soft-clip + normalize
mix = np.tanh(mix * 1.4)
mix *= 0.7 / np.max(np.abs(mix))

pcm = (mix * 32767).astype('<i2')
stereo = np.repeat(pcm[:, None], 2, axis=1)
with wave.open('music.wav', 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes(stereo.tobytes())
print('music.wav written', DUR, 's; beat at', BEAT)
