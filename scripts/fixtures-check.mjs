// Assert-based self-check for the VAD boundary pipeline. No test framework.
//
// Usage: node scripts/fixtures-check.mjs
//
// Generates the synthetic Sources (if missing), runs Silero VAD directly on
// each via onnxruntime-node at 512-sample frames, derives Statement boundaries
// from raw frame probabilities with hysteresis (the algorithm ADR-0001 wants
// the pipeline to use), and asserts:
//   - detected boundaries land within +-60 ms of ground truth
//   - the 200 ms internal pause in split-statement bridges into one Statement
//   - background noise under the voice band does not move boundaries
//   - noise alone yields no Statement
//   - detection is deterministic: two runs at fixed settings agree exactly
//   - the vendored silero_vad.onnx matches the pinned sha256

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generate } from "./fixtures-gen.mjs";

const require = createRequire(import.meta.url);
const ort = require("onnxruntime-node");

// --- pinned model -----------------------------------------------------------
// silero-vad onnx vendored by @ricky0123/vad-node@0.0.3 (MIT-licensed model,
// source: snakers4/silero-vad v4 model card).
const PINNED_MODEL_SHA256 = "a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28";

function modelPath() {
  return join(dirname(require.resolve("@ricky0123/vad-node")), "silero_vad.onnx");
}

// --- minimal WAV reader (PCM16 only) ----------------------------------------
function readPcm16Mono(path) {
  const buf = readFileSync(path);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`${path}: not a RIFF/WAVE file`);
  }
  let off = 12;
  let fmt = null;
  let data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = buf.subarray(off + 8, off + 8 + size);
    if (id === "fmt ") fmt = body;
    else if (id === "data") data = body;
    off += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error(`${path}: missing fmt/data chunk`);
  if (fmt.readUInt16LE(0) !== 1) throw new Error(`${path}: not PCM`);
  if (fmt.readUInt16LE(2) !== 1 || fmt.readUInt32LE(4) !== 16000) {
    throw new Error(`${path}: expected 16 kHz mono`);
  }
  if (fmt.readUInt16LE(14) !== 16) throw new Error(`${path}: expected 16-bit samples`);
  const n = data.length >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = data.readInt16LE(i * 2) / 32768;
  return out;
}

// --- Silero VAD at 512-sample frames -> raw per-frame probabilities ----------
const FRAME_SAMPLES = 512; // silero-supported size at 16 kHz; 32 ms per frame
const H = () => new ort.Tensor("float32", new Float32Array(128), [2, 1, 64]);
const C = () => new ort.Tensor("float32", new Float32Array(128), [2, 1, 64]);

async function frameProbs(session, audio) {
  const probs = [];
  let h = H();
  let c = C();
  const sr = new ort.Tensor("int64", [16000n]);
  for (let off = 0; off + FRAME_SAMPLES <= audio.length; off += FRAME_SAMPLES) {
    const input = new ort.Tensor("float32", audio.subarray(off, off + FRAME_SAMPLES), [1, FRAME_SAMPLES]);
    const out = await session.run({ input, h, c, sr });
    h = out.hn;
    c = out.cn;
    probs.push(out.output.data[0]);
  }
  return probs;
}

// --- boundary derivation from raw probs (hysteresis + redemption) ------------
const POSITIVE_THRESHOLD = 0.5;
const NEGATIVE_THRESHOLD = 0.35; // silero convention: positive - 0.15
const MIN_SPEECH_FRAMES = 3; // 96 ms: ignore shorter blips
const REDEMPTION_FRAMES = 10; // 320 ms: bridges the 200 ms internal pause
const TOLERANCE_MS = 60;

// --- sample-domain edge refinement ------------------------------------------
// The Silero LSTM keeps emitting high probabilities for ~4 frames after a hard
// offset (state decay), so raw threshold crossings overshoot the true end. The
// pipeline should treat VAD as the coarse segmenter and recover exact edges from
// a short-window energy envelope inside and just outside each coarse Range.
const RMS_WINDOW = 160; // 10 ms

function rmsEnvelope(audio) {
  const out = [];
  for (let off = 0; off + RMS_WINDOW <= audio.length; off += RMS_WINDOW) {
    let sum = 0;
    for (let i = off; i < off + RMS_WINDOW; i++) sum += audio[i] * audio[i];
    out.push({ startMs: (off / 16000) * 1000, rms: Math.sqrt(sum / RMS_WINDOW) });
  }
  return out;
}

function refineRange(audio, coarse) {
  const env = rmsEnvelope(audio);
  const leadWindows = env.filter((w) => w.startMs < 300);
  const sortedLead = leadWindows.map((w) => w.rms).sort((a, b) => a - b);
  const noiseFloor = sortedLead.length ? sortedLead[sortedLead.length >> 1] : 0;
  const peak = env.reduce((m, w) => Math.max(m, w.rms), 0);
  const threshold = Math.max(2.5 * noiseFloor, 0.15 * peak);
  const inWindow = (w, lo, hi) => w.startMs >= lo && w.startMs <= hi;

  const startCandidates = env.filter((w) =>
    inWindow(w, coarse.startMs - 160, coarse.startMs + 96) && w.rms >= threshold);
  // End refinement requires two consecutive windows (20 ms) above threshold so
  // a lone background-noise spike does not extend the Statement.
  const endCandidates = env
    .map((w, i) => ({ w, prevAbove: i > 0 && env[i - 1].rms >= threshold }))
    .filter(({ w, prevAbove }) =>
      inWindow(w, coarse.endMs - 288, coarse.endMs + 64) && w.rms >= threshold && prevAbove);

  return {
    startMs: startCandidates.length ? startCandidates[0].startMs : coarse.startMs,
    endMs: endCandidates.length
      ? endCandidates[endCandidates.length - 1].w.startMs + RMS_WINDOW / 16
      : coarse.endMs,
  };
}

function detectRanges(audio, probs) {
  const frameMs = (FRAME_SAMPLES / 16000) * 1000;
  const ranges = [];
  let state = "idle";
  let streak = 0;
  let startFrame = 0;
  let lastVoiceFrame = -1;
  let dip = 0;

  const flush = () => {
    if (state === "speak") {
      ranges.push({ startMs: startFrame * frameMs, endMs: (lastVoiceFrame + 1) * frameMs });
    }
    state = "idle";
    streak = 0;
    dip = 0;
    lastVoiceFrame = -1;
  };

  for (let i = 0; i < probs.length; i++) {
    const p = probs[i];
    if (state === "idle") {
      if (p >= POSITIVE_THRESHOLD) {
        if (streak === 0) startFrame = i;
        streak++;
        if (streak >= MIN_SPEECH_FRAMES) state = "speak";
      } else {
        streak = 0;
      }
    } else if (p >= NEGATIVE_THRESHOLD) {
      lastVoiceFrame = i;
      dip = 0;
    } else if (++dip >= REDEMPTION_FRAMES) {
      flush();
    }
  }
  flush();
  return ranges.map((r) => refineRange(audio, r));
}

// --- the check ---------------------------------------------------------------
let failures = 0;
function assert(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  const modelFile = modelPath();
  const hash = createHash("sha256").update(readFileSync(modelFile)).digest("hex");
  assert("model hash pinned", hash === PINNED_MODEL_SHA256, hash);

  const { manifest, outDir } = generate();
  const session = await ort.InferenceSession.create(modelFile);

  for (const fixture of manifest.fixtures) {
    const audio = readPcm16Mono(join(outDir, fixture.file));
    const probs = await frameProbs(session, audio);
    const detected = detectRanges(audio, probs);
    const expected = fixture.statements.map((s) => `${s.startMs}..${s.endMs} ms`).join(", ") || "none";

    assert(`${fixture.id}: Statement count`,
      detected.length === fixture.statements.length,
      `expected ${fixture.statements.length} (${expected}), got ${JSON.stringify(detected)}`);
    if (detected.length !== fixture.statements.length) continue;

    let allClose = true;
    const detail = [];
    for (let i = 0; i < detected.length; i++) {
      const { startMs: ds, endMs: de } = detected[i];
      const { startMs: gs, endMs: ge } = fixture.statements[i];
      const dStart = ds - gs;
      const dEnd = de - ge;
      detail.push(`Δstart ${dStart} ms, Δend ${dEnd} ms`);
      if (!Number.isFinite(dStart) || !Number.isFinite(dEnd)) allClose = false;
      else if (Math.abs(dStart) > TOLERANCE_MS || Math.abs(dEnd) > TOLERANCE_MS) allClose = false;
    }
    assert(`${fixture.id}: boundaries within ±${TOLERANCE_MS} ms`, allClose, detail.join("; "));

    // Determinism at fixed settings: a second full run must agree exactly.
    const detectedAgain = detectRanges(audio, await frameProbs(session, audio));
    assert(`${fixture.id}: deterministic across re-runs`,
      JSON.stringify(detected) === JSON.stringify(detectedAgain));
  }

  console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
