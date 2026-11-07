import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import type { SidecarV1, SidecarStatement } from "./sidecar.ts";
import { saveSidecar } from "./sidecar.ts";
import { transcribeAudio } from "./transcript.ts";

const require = createRequire(import.meta.url);
const FFMPEG: string = require("ffmpeg-static");

export interface RenderResult {
  rendered: number;
  skipped: number;
  clips: Array<{
    id: string;
    path: string;
    bytes: number;
    renderedFrom: string;
    method: "loudnorm" | "peak-normalize";
  }>;
}

export interface RenderOptions {
  force?: boolean;
  sidecarPath?: string;
  transcript?: boolean;
}

/**
 * Compute the hash that determines if a clip needs re-rendering.
 * Hash of statement bounds + source path.
 */
export function clipRenderHash(stmt: { startMs: number; endMs: number }, sourcePath: string): string {
  return createHash("sha256")
    .update(`${stmt.startMs}|${stmt.endMs}|${sourcePath}`)
    .digest("hex")
    .slice(0, 16);
}

/**
 * Measure integrated loudness and true peak of an audio file using loudnorm pass 1.
 */
export async function measureLoudness(filePath: string): Promise<{ inputI: number; inputTp: number }> {
  const res = await runFfmpeg([
    "-i", filePath,
    "-af", "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json",
    "-f", "null", "-",
  ]);
  const jsonStart = res.stderr.indexOf("{");
  const jsonEnd = res.stderr.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1) {
    throw new Error(`Failed to parse loudnorm JSON output: ${res.stderr}`);
  }
  const stats = JSON.parse(res.stderr.slice(jsonStart, jsonEnd + 1));
  return {
    inputI: parseFloat(stats.input_i),
    inputTp: parseFloat(stats.input_tp),
  };
}

/**
 * Helper to run ffmpeg with argument list and capture stderr/stdout.
 */
function runFfmpeg(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, ["-hide_banner", "-nostdin", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-500)}`));
      } else {
        resolve({ stdout, stderr, code });
      }
    });
  });
}

/**
 * Render one statement clip into an MP3 file.
 * - Below 0.5 s: peak-normalize to -1.5 dBTP (via ebur128 true peak or volumedetect fallback).
 * - >= 0.5 s: two-pass loudnorm I=-16:TP=-1.5:LRA=11.
 * - Output format: -ac 1 -c:a libmp3lame -q:a 4 -ar 44100
 */
export async function renderClip(
  sourcePath: string,
  stmt: { startMs: number; endMs: number },
  outPath: string
): Promise<{ method: "loudnorm" | "peak-normalize"; bytes: number }> {
  mkdirSync(dirname(outPath), { recursive: true });

  const durationMs = stmt.endMs - stmt.startMs;
  const startSec = (stmt.startMs / 1000).toFixed(3);
  const endSec = (stmt.endMs / 1000).toFixed(3);

  if (durationMs < 500) {
    // Peak-normalize fallback: below 0.5 s loudnorm cannot measure short input
    // Measure peak using ebur128=peak=true, falling back to volumedetect
    const p1 = await runFfmpeg([
      "-ss", startSec,
      "-to", endSec,
      "-i", sourcePath,
      "-af", "ebur128=peak=true",
      "-f", "null", "-",
    ]);

    let peak: number | null = null;
    const peakMatch = p1.stderr.match(/True peak:\s*\n\s*Peak:\s*(-?[\d.]+)\s*dBFS/i)
      || p1.stderr.match(/Peak:\s*(-?[\d.]+)\s*dBFS/);

    if (peakMatch && peakMatch[1]) {
      const val = parseFloat(peakMatch[1]);
      if (Number.isFinite(val)) peak = val;
    }

    if (peak === null) {
      // Fallback measurement: volumedetect
      const vd = await runFfmpeg([
        "-ss", startSec,
        "-to", endSec,
        "-i", sourcePath,
        "-af", "volumedetect",
        "-f", "null", "-",
      ]);
      const vdMatch = vd.stderr.match(/max_volume:\s*(-?[\d.]+)\s*dB/);
      if (vdMatch && vdMatch[1]) {
        const val = parseFloat(vdMatch[1]);
        if (Number.isFinite(val)) peak = val;
      }
    }

    // Gain to reach -1.5 dBTP
    let gainStr = "0dB";
    if (peak !== null && peak > -90) {
      const gain = -1.5 - peak;
      gainStr = `${gain >= 0 ? "+" : ""}${gain.toFixed(2)}dB`;
    }

    await runFfmpeg([
      "-ss", startSec,
      "-to", endSec,
      "-i", sourcePath,
      "-af", `volume=${gainStr}`,
      "-ac", "1",
      "-c:a", "libmp3lame",
      "-q:a", "4",
      "-ar", "44100",
      "-y",
      outPath,
    ]);

    const bytes = statSync(outPath).size;
    return { method: "peak-normalize", bytes };
  }

  // Two-pass loudnorm: Pass 1 measure
  const p1 = await runFfmpeg([
    "-ss", startSec,
    "-to", endSec,
    "-i", sourcePath,
    "-af", "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json",
    "-f", "null", "-",
  ]);

  const jsonStart = p1.stderr.indexOf("{");
  const jsonEnd = p1.stderr.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1) {
    throw new Error(`Failed to parse loudnorm pass 1 JSON output: ${p1.stderr}`);
  }
  const stats = JSON.parse(p1.stderr.slice(jsonStart, jsonEnd + 1));

  // If measured integrated loudness is -inf, fallback to linear / safe values
  const filter = [
    "loudnorm=I=-16:TP=-1.5:LRA=11",
    `measured_I=${stats.input_i}`,
    `measured_TP=${stats.input_tp}`,
    `measured_LRA=${stats.input_lra}`,
    `measured_thresh=${stats.input_thresh}`,
    `offset=${stats.target_offset}`,
    "linear=true",
  ].join(":");

  // Pass 2 render
  await runFfmpeg([
    "-ss", startSec,
    "-to", endSec,
    "-i", sourcePath,
    "-af", filter,
    "-ac", "1",
    "-c:a", "libmp3lame",
    "-q:a", "4",
    "-ar", "44100",
    "-y",
    outPath,
  ]);

  const bytes = statSync(outPath).size;
  return { method: "loudnorm", bytes };
}

/**
 * Render all statements in a sidecar, updating statement.clip and re-rendering only when needed.
 */
export async function renderClips(
  sidecar: SidecarV1,
  outDir: string,
  options: RenderOptions = {}
): Promise<RenderResult> {
  const force = options.force ?? false;
  const wantTranscript = options.transcript ?? false;
  let rendered = 0;
  let skipped = 0;
  let updatedTranscript = false;
  const clips: RenderResult["clips"] = [];

  for (const stmt of sidecar.statements) {
    const hash = clipRenderHash(stmt, sidecar.source.path);
    const clipFilename = `${stmt.id}.mp3`;
    const clipPath = join(outDir, clipFilename);

    const needsRender =
      force ||
      !stmt.clip ||
      stmt.clip.renderedFrom !== hash ||
      !existsSync(stmt.clip.path || clipPath);

    if (needsRender) {
      const res = await renderClip(sidecar.source.path, stmt, clipPath);
      stmt.clip = {
        path: clipPath,
        bytes: res.bytes,
        renderedFrom: hash,
      };
      rendered++;
      clips.push({
        id: stmt.id,
        path: clipPath,
        bytes: res.bytes,
        renderedFrom: hash,
        method: res.method,
      });
    } else {
      skipped++;
      clips.push({
        id: stmt.id,
        path: stmt.clip?.path ?? clipPath,
        bytes: stmt.clip?.bytes ?? (existsSync(clipPath) ? statSync(clipPath).size : 0),
        renderedFrom: stmt.clip?.renderedFrom ?? hash,
        method: stmt.endMs - stmt.startMs < 500 ? "peak-normalize" : "loudnorm",
      });
    }

    if (wantTranscript && (!stmt.transcript || needsRender)) {
      const clipToTranscribe = stmt.clip?.path || clipPath;
      if (existsSync(clipToTranscribe)) {
        const record = await transcribeAudio(clipToTranscribe);
        stmt.transcript = record;
        updatedTranscript = true;
      }
    } else if (!wantTranscript) {
      stmt.transcript = null;
    }
  }

  if (options.sidecarPath && (rendered > 0 || updatedTranscript)) {
    saveSidecar(options.sidecarPath, sidecar);
  }

  return { rendered, skipped, clips };
}
