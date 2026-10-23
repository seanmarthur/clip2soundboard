// Synthetic Source generator for the VAD boundary pipeline.
//
// Emits deterministic 16 kHz mono PCM16 WAV Sources with known Statement
// boundaries, plus a ground-truth JSON. Voice is synthesised here (a harmonic
// stack with a syllabic envelope) because Silero VAD is a speech model: a pure
// sine tone sits in its out-of-distribution tail and yields marginal (>0.5)
// probabilities. ffmpeg-static does the encode and the noise-floor mix.
//
// Usage: node scripts/fixtures-gen.mjs [outDir]
//   outDir defaults to scripts/fixtures/ (gitignored).
//
// ponytail: fixture set is three positive cases + one negative; add more only
// when a real pipeline bug needs a reproducer.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const FFMPEG = require("ffmpeg-static");
const SAMPLE_RATE = 16000;

const FIXTURES = [
  {
    id: "micro-statement",
    durationMs: 1300,
    voice: [[500, 800]], // 0.3 s micro-Statement
    noise: null,
    statements: [{ startMs: 500, endMs: 800 }],
    notes: "single 0.3 s micro-Statement in silence",
  },
  {
    id: "split-statement",
    durationMs: 2000,
    voice: [[500, 900], [1100, 1500]], // 200 ms internal pause at 900..1100
    noise: null,
    statements: [{ startMs: 500, endMs: 1500 }],
    notes: "one Statement split by a 200 ms pause; Fuzziness must bridge it",
  },
  {
    id: "noise-floor",
    durationMs: 1600,
    voice: [[400, 1000]],
    // Pink noise low-passed to 300 Hz: energy below the voice band.
    noise: { colour: "pink", amplitude: 0.15, lowpassHz: 300 },
    statements: [{ startMs: 400, endMs: 1000 }],
    notes: "Statement over sub-voice-band background noise",
  },
  {
    id: "silence-only",
    durationMs: 1000,
    voice: [],
    noise: { colour: "pink", amplitude: 0.15, lowpassHz: 300 },
    statements: [],
    notes: "negative case: background noise alone must yield no Statement",
  },
];

/** Deterministic speech-like voice track, full fixture length, int16 LE.
 * A light broadband dither keeps the harmonic stack out of the pure-periodic
 * degenerate case that Silero scores marginally (~0.4); with it probabilities
 * are >0.9 on voice and <0.1 in silence. */
function synthVoice(durationMs, bursts) {
  const n = Math.round((durationMs / 1000) * SAMPLE_RATE);
  const pcm = new Int16Array(n);
  const HARMONICS = 16;
  const f0 = 120;
  const rand = mulberry32(0x5eed);
  for (let i = 0; i < n; i++) pcm[i] = Math.round((rand() - 0.5) * 0.02 * 0x7fff);
  for (const [startMs, endMs] of bursts) {
    const from = Math.round((startMs / 1000) * SAMPLE_RATE);
    const to = Math.round((endMs / 1000) * SAMPLE_RATE);
    for (let i = from; i < to && i < n; i++) {
      const t = i / SAMPLE_RATE;
      const syllable = 0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t);
      let s = 0;
      for (let h = 1; h <= HARMONICS; h++) {
        s += Math.sin(2 * Math.PI * f0 * h * t) / (h * h);
      }
      const v = s * syllable * 0.3 + (rand() - 0.5) * 0.02;
      pcm[i] = Math.max(-1, Math.min(1, v)) * 0x7fff;
    }
  }
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
}

/** Deterministic 32-bit PRNG (mulberry32). */
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function encodeFixture(outDir, fixture, voice) {
  const rawPath = join(outDir, `${fixture.id}.pcm`);
  const wavPath = join(outDir, `${fixture.id}.wav`);
  writeFileSync(rawPath, voice);

  const args = ["-hide_banner", "-loglevel", "error", "-y",
    "-f", "s16le", "-ar", String(SAMPLE_RATE), "-ac", "1", "-i", rawPath];

  if (fixture.noise) {
    const { colour, amplitude, lowpassHz } = fixture.noise;
    args.push(
      "-f", "lavfi", "-i",
      `anoisesrc=colour=${colour}:sample_rate=${SAMPLE_RATE}:duration=${fixture.durationMs / 1000}:amplitude=${amplitude}`,
      "-filter_complex",
      `[1:a]lowpass=f=${lowpassHz}[n];[0:a][n]amix=inputs=2:duration=first:normalize=0[m]`,
      "-map", "[m]",
    );
  }

  args.push("-ar", String(SAMPLE_RATE), "-ac", "1", "-c:a", "pcm_s16le", wavPath);
  execFileSync(FFMPEG, args);
  return wavPath;
}

export function generate(outDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures")) {
  mkdirSync(outDir, { recursive: true });
  const fixtures = [];
  for (const fixture of FIXTURES) {
    const voice = synthVoice(fixture.durationMs, fixture.voice);
    encodeFixture(outDir, fixture, voice);
    const { voice: _v, noise, ...rest } = fixture;
    fixtures.push({ ...rest, file: `${fixture.id}.wav`, hasNoise: Boolean(noise) });
  }
  const manifest = {
    generatedBy: "scripts/fixtures-gen.mjs",
    sampleRate: SAMPLE_RATE,
    note: "All boundaries are ground truth in milliseconds from Source start.",
    fixtures,
  };
  const manifestPath = join(outDir, "ground-truth.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return { manifest, manifestPath, outDir };
}

export function sha256(path) {
  const { readFileSync } = require("node:fs");
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const outDir = process.argv[2] ? resolve(process.argv[2]) : undefined;
  const { manifestPath, manifest } = generate(outDir);
  console.log(`wrote ${manifest.fixtures.length} fixtures + ${manifestPath}`);
}
