// detectStatements: the Detect core. Decodes a Source, runs Silero VAD at
// 512-sample frames, and derives Statement boundaries with energy-envelope
// edge recovery — VAD frames alone overshoot statement ends by up to ~190 ms
// (measured: research/silero-vad-in-node.md), so VAD is only the coarse
// segmenter. ADR-0001 + decisions #5/#6.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const ort = require("onnxruntime-node");
const FFMPEG: string = require("ffmpeg-static");

export interface Statement {
  startMs: number;
  endMs: number;
  peakProb: number;
  detection: { startMs: number; endMs: number };
  candidates: { onsetValleyMs: number | null; offsetValleyMs: number | null };
}

export interface DetectOptions {
  positiveThreshold?: number; // default 0.5
  minSpeechFrames?: number; // default 3 (96 ms)
  redemptionFrames?: number; // default 10 (320 ms, bridges a 200 ms pause)
  cleanup?: boolean; // default true: highpass=f=80,afftdn=nf=-25
}

const FRAME_SAMPLES = 512; // silero frame at 16 kHz = 32 ms
const SAMPLE_RATE = 16000;
const NEGATIVE_MARGIN = 0.15; // silero convention: positive − 0.15
const RMS_WINDOW = 160; // 10 ms energy envelope window
const CANDIDATE_SPAN_MS = 250; // window searched for the valley next to an edge

// --- decode ------------------------------------------------------------------
async function decodeToPcm16(sourcePath: string, cleanup: boolean): Promise<Float32Array> {
  const args = ["-hide_banner", "-nostdin", "-i", sourcePath];
  if (cleanup) args.push("-af", "highpass=f=80,afftdn=nf=-25");
  args.push("-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "s16le", "pipe:1");
  const proc = spawn(FFMPEG, args, { stdio: ["ignore", "pipe", "pipe"] });
  const chunks: Buffer[] = [];
  let stderr = "";
  proc.stdout.on("data", (c: Buffer) => chunks.push(c));
  proc.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
  const [code] = await new Promise<[number | null]>((res) =>
    proc.on("close", (c) => res([c])),
  );
  if (code !== 0) throw new Error(`ffmpeg failed (${sourcePath}): ${stderr.slice(-500)}`);
  const pcm = Buffer.concat(chunks);
  const out = new Float32Array(pcm.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = pcm.readInt16LE(i * 2) / 32768;
  return out;
}

// --- VAD ---------------------------------------------------------------------
function modelPath(): string {
  return require.resolve("@ricky0123/vad-node").replace(/[^/\\]+$/, "silero_vad.onnx");
}

async function frameProbs(session: unknown, audio: Float32Array): Promise<number[]> {
  const s = session as {
    run: (i: Record<string, unknown>) => Promise<{ [k: string]: { data: Float32Array } }>;
  };
  const H = () => new ort.Tensor("float32", new Float32Array(128), [2, 1, 64]);
  const C = () => new ort.Tensor("float32", new Float32Array(128), [2, 1, 64]);
  const probs: number[] = [];
  let h = H();
  let c = C();
  const sr = new ort.Tensor("int64", [16000n]);
  for (let off = 0; off + FRAME_SAMPLES <= audio.length; off += FRAME_SAMPLES) {
    const input = new ort.Tensor("float32", audio.subarray(off, off + FRAME_SAMPLES), [1, FRAME_SAMPLES]);
    const out = await s.run({ input, h, c, sr });
    h = out.hn as unknown;
    c = out.cn as unknown;
    probs.push(out.output.data[0]);
  }
  return probs;
}

// --- energy envelope + edge recovery ----------------------------------------
interface EnvelopeStep {
  startMs: number;
  rms: number;
}

function rmsEnvelope(audio: Float32Array): EnvelopeStep[] {
  const out: EnvelopeStep[] = [];
  for (let off = 0; off + RMS_WINDOW <= audio.length; off += RMS_WINDOW) {
    let sum = 0;
    for (let i = off; i < off + RMS_WINDOW; i++) sum += audio[i] * audio[i];
    out.push({ startMs: (off / SAMPLE_RATE) * 1000, rms: Math.sqrt(sum / RMS_WINDOW) });
  }
  return out;
}

function refineRange(env: EnvelopeStep[], coarse: { startMs: number; endMs: number }) {
  // Noise floor from the quiet lead of the Source; threshold relative to it.
  const lead = env.filter((w) => w.startMs < 300).map((w) => w.rms).sort((a, b) => a - b);
  const noiseFloor = lead.length ? lead[lead.length >> 1] : 0;
  const peak = env.reduce((m, w) => Math.max(m, w.rms), 0);
  const threshold = Math.max(2.5 * noiseFloor, 0.15 * peak);
  const inWindow = (w: EnvelopeStep, lo: number, hi: number) => w.startMs >= lo && w.startMs <= hi;

  const starts = env.filter((w) => inWindow(w, coarse.startMs - 160, coarse.startMs + 96) && w.rms >= threshold);
  // Two consecutive above-threshold windows (20 ms) end a Statement, so a lone
  // background-noise spike cannot extend it.
  const ends = env
    .map((w, i) => ({ w, prevAbove: i > 0 && env[i - 1].rms >= threshold }))
    .filter(({ w, prevAbove }) => inWindow(w, coarse.endMs - 288, coarse.endMs + 64) && w.rms >= threshold && prevAbove);

  const startMs = starts.length ? starts[0].startMs : coarse.startMs;
  const endMs = ends.length ? ends[ends.length - 1].w.startMs + RMS_WINDOW / 16 : coarse.endMs;

  // Valley candidates for the Fuzziness re-run (decision #6): the quietest
  // envelope window within ±250 ms on either side of each refined edge.
  const near = (edge: number, lo: number, hi: number) =>
    env.filter((w) => inWindow(w, lo, hi) && w.rms < threshold).map((w) => w.startMs);
  const onset = near(startMs, startMs - CANDIDATE_SPAN_MS, startMs);
  const offset = near(endMs, endMs, endMs + CANDIDATE_SPAN_MS);
  return {
    startMs,
    endMs,
    candidates: {
      onsetValleyMs: onset.length ? Math.min(...onset) : null,
      offsetValleyMs: offset.length ? Math.max(...offset) : null,
    },
    threshold,
  };
}

// --- coarse range derivation (hysteresis) ------------------------------------
function detectCoarse(probs: number[], opts: Required<DetectOptions>) {
  const negative = opts.positiveThreshold - NEGATIVE_MARGIN;
  const frameMs = (FRAME_SAMPLES / SAMPLE_RATE) * 1000;
  const ranges: { startMs: number; endMs: number; peakProb: number }[] = [];
  let state: "idle" | "speak" = "idle";
  let streak = 0;
  let startFrame = 0;
  let lastVoiceFrame = -1;
  let dip = 0;
  let peak = 0;

  const flush = () => {
    if (state === "speak")
      ranges.push({ startMs: startFrame * frameMs, endMs: (lastVoiceFrame + 1) * frameMs, peakProb: peak });
    state = "idle";
    streak = 0;
    dip = 0;
    peak = 0;
    lastVoiceFrame = -1;
  };

  for (let i = 0; i < probs.length; i++) {
    const p = probs[i];
    if (state === "idle") {
      if (p >= opts.positiveThreshold) {
        if (streak === 0) startFrame = i;
        streak++;
        if (streak >= opts.minSpeechFrames) {
          state = "speak";
          lastVoiceFrame = i;
          peak = p;
        }
      } else {
        streak = 0;
      }
    } else if (p >= negative) {
      lastVoiceFrame = i;
      dip = 0;
      peak = Math.max(peak, p);
    } else if (++dip >= opts.redemptionFrames) {
      flush();
    }
  }
  flush();
  return ranges;
}

// --- seam --------------------------------------------------------------------
export async function detectStatements(sourcePath: string, options: DetectOptions = {}): Promise<Statement[]> {
  const opts: Required<DetectOptions> = {
    positiveThreshold: 0.5,
    minSpeechFrames: 3,
    redemptionFrames: 10,
    cleanup: true,
    ...options,
  };
  const audio = await decodeToPcm16(sourcePath, opts.cleanup);
  const session = await ort.InferenceSession.create(modelPath());
  const probs = await frameProbs(session, audio);
  const env = rmsEnvelope(audio);
  return detectCoarse(probs, opts).map((coarse) => {
    const refined = refineRange(env, coarse);
    return {
      startMs: refined.startMs,
      endMs: refined.endMs,
      peakProb: coarse.peakProb,
      detection: { startMs: coarse.startMs, endMs: coarse.endMs },
      candidates: refined.candidates,
    };
  });
}
