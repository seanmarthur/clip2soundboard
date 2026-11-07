import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const FFMPEG: string = require("ffmpeg-static");

export interface TranscriptRecord {
  text: string;
  model: string;
  at: number;
}

export interface TranscribeOptions {
  model?: string;
}

export const DEFAULT_WHISPER_MODEL = "Xenova/whisper-base.en";

// Cached transcriber pipeline promise
let pipelinePromise: Promise<any> | null = null;

async function getTranscriber(modelName: string): Promise<any> {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const { pipeline, env } = await import("@xenova/transformers");
      // Cache locally and disallow remote downloads in test / offline runs
      env.allowRemoteModels = false;
      return await pipeline("automatic-speech-recognition", modelName);
    })();
  }
  return pipelinePromise;
}

/**
 * Decode audio file at filePath to 16kHz mono Float32Array PCM for whisper.
 */
export async function decodeAudioToFloat32(filePath: string): Promise<Float32Array> {
  const args = ["-hide_banner", "-nostdin", "-i", filePath, "-ac", "1", "-ar", "16000", "-f", "f32le", "pipe:1"];
  const proc = spawn(FFMPEG, args, { stdio: ["ignore", "pipe", "pipe"] });
  const chunks: Buffer[] = [];
  let stderr = "";
  proc.stdout.on("data", (c: Buffer) => chunks.push(c));
  proc.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
  const [code] = await new Promise<[number | null]>((res, rej) => {
    proc.on("error", rej);
    proc.on("close", (c) => res([c]));
  });
  if (code !== 0) throw new Error(`ffmpeg failed to decode ${filePath}: ${stderr.slice(-500)}`);
  const buf = Buffer.concat(chunks);
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/**
 * Transcribe an audio file using Whisper.
 */
export async function transcribeAudio(
  filePath: string,
  options: TranscribeOptions = {}
): Promise<TranscriptRecord> {
  const modelName = options.model ?? DEFAULT_WHISPER_MODEL;
  const transcriber = await getTranscriber(modelName);
  const audioData = await decodeAudioToFloat32(filePath);
  const result = await transcriber(audioData);
  const text = (result?.text ?? "").trim();
  const at = Date.now();
  return {
    text,
    model: modelName,
    at,
  };
}
