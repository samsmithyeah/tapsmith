#!/usr/bin/env node
// Voiceover: vo/lines.txt -> vo/seg<n>.mp3 via the ElevenLabs text-to-speech API.
//   node generate-vo.mjs            every segment (ELEVENLABS_API_KEY from env or .env)
//   node generate-vo.mjs 2a 8       only these segments
// Prints each segment's spoken length against the room it has on the timeline
// (the gap to the next segment's adelay in assemble.sh) and exits non-zero if
// any segment overruns — re-time or re-word before assembling.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// The key can live in tools/promo/.env (git-ignored); a real env var wins.
if (existsSync(join(HERE, '.env'))) process.loadEnvFile(join(HERE, '.env'));
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID ?? 'bZOiovivKA2Bl3lLvbC6';
const MODEL_ID = process.env.ELEVENLABS_MODEL_ID ?? 'eleven_v4';
const API = 'https://api.elevenlabs.io/v1';
// Fixed seed so a re-run of an unchanged line comes back (near-)identical.
const SEED = 20260929;

// ─── Per-segment delivery ───
// speed is ElevenLabs' 0.7–1.2 multiplier. 2a "Tapsmith is the next step." is
// slowed so it breathes in the near-silent bed and lands on BEAT; 8, the
// feature list, is quickened to fit its scene.
const DEFAULT_SPEED = 0.96;
const SPEED = { '2a': 0.9, '8': 1.08 };

// ─── Timeline room ───
// Start offsets (s) from assemble.sh's adelay values; each segment may run until
// the next one starts (2a must finish by comp.html's BEAT, 17.0). Keep in sync.
const START = { 1: 0.6, '2a': 15.1, '2b': 17.55, 3: 32.9, 4: 51.5, 5: 62.8, 6: 75.9, 7: 92.7, 8: 109.3, 9: 125.6 };
const END = { '2a': 17.0, 9: 131.9 };
const ORDER = Object.keys(START).sort((a, b) => START[a] - START[b]);
const room = (n) => (END[n] ?? START[ORDER[ORDER.indexOf(n) + 1]]) - START[n];

const key = process.env.ELEVENLABS_API_KEY;
if (!key) {
  console.error('ELEVENLABS_API_KEY is not set (create one at https://elevenlabs.io/app/settings/api-keys).');
  process.exit(2);
}
const headers = { 'xi-api-key': key, 'content-type': 'application/json' };

async function api(path, init) {
  const res = await fetch(`${API}${path}`, { headers, ...init });
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

// Fail early (with the valid ids) on a mistyped model rather than per segment.
const models = await api('/models');
if (!models.some((m) => m.model_id === MODEL_ID)) {
  console.error(`Unknown model ${MODEL_ID}. Available: ${models.map((m) => m.model_id).join(', ')}`);
  process.exit(2);
}

const lines = readFileSync(join(HERE, 'vo/lines.txt'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    const i = l.indexOf('|');
    return { n: l.slice(0, i), text: l.slice(i + 1) };
  });
const only = process.argv.slice(2);
let overrun = false;

for (const { n, text } of lines) {
  if (only.length && !only.includes(n)) continue;
  const out = await api(`/text-to-speech/${VOICE_ID}/with-timestamps?output_format=mp3_44100_128`, {
    method: 'POST',
    body: JSON.stringify({
      text,
      model_id: MODEL_ID,
      seed: SEED,
      voice_settings: { speed: SPEED[n] ?? DEFAULT_SPEED },
    }),
  });
  writeFileSync(join(HERE, `vo/seg${n}.mp3`), Buffer.from(out.audio_base64, 'base64'));
  const ends = out.alignment?.character_end_times_seconds ?? [];
  const spoken = ends.length ? ends[ends.length - 1] : NaN;
  const fits = !(spoken > room(n));
  overrun ||= !fits;
  console.log(`seg${n.padEnd(3)} ${spoken.toFixed(2)}s spoken / ${room(n).toFixed(2)}s room ${fits ? '' : '  OVERRUNS'}`);
}
process.exit(overrun ? 1 : 0);
