import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";

const require = createRequire(import.meta.url);
const FFMPEG: string = require("ffmpeg-static");

export interface RenderOptions {
  loudnormTargetI?: number;
  loudnormTargetTP?: number;
  loudnormTargetLRA?: number;
}

export interface RenderResult {
  statements: RenderedStatement[];
  errors: string[];
}

export interface RenderedStatement {
  id: string;
  clipPath: string;
  bytes: number;
  startMs: number;
  endMs: number;
  boundsHash: string;
}

export interface StatementToRender {
  id: string;
  startMs: number;
  endMs: number;
  sourcePath: string;
}

export interface RenderContext {
  statements: StatementToRender[];
  outDir: string;
  opts: RenderOptions;
}

function parseLoudnormOutput(output: string): { input_i: string; input_tp: string; input_lra: string; input_thresh: string; target_offset: string } | null {
  let braceCount = 0;
  let inJson = false;
  let jsonStart = -1;

  for (let i = 0; i < output.length; i++) {
    if (output[i] === "{") {
      if (!inJson) {
        inJson = true;
        jsonStart = i;
      }
      braceCount++;
    } else if (output[i] === "}") {
      if (inJson) {
        braceCount--;
        if (braceCount === 0 && jsonStart >= 0) {
          const jsonStr = output.slice(jsonStart, i + 1);
          try {
            const parsed = JSON.parse(jsonStr);
            if (parsed.input_i !== undefined) {
              return {
                input_i: parsed.input_i,
                input_tp: parsed.input_tp,
                input_lra: parsed.input_lra,
                input_thresh: parsed.input_thresh,
                target_offset: parsed.target_offset,
              };
            }
          } catch {}
          inJson = false;
          jsonStart = -1;
        }
      }
    }
  }
  return null;
}

async function runFfmpeg(bin: string, args: string[], onStdout?: (out: string) => void, onStderr?: (out: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args);
    let stderr = "";
    proc.stdout.on("data", (c) => onStdout?.(c.toString()));
    proc.stderr.on("data", (c) => {
      stderr += c.toString();
      onStderr?.(c.toString());
    });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error("ffmpeg exited " + code + ": " + stderr.slice(-500)));
    });
    proc.on("error", reject);
  });
}

function buildLoudnormFilter(opts: { loudnormTargetI?: number; loudnormTargetTP?: number; loudnormTargetLRA?: number }, measured?: { input_i: string; input_tp: string; input_lra: string; input_thresh: string; target_offset: string }): string {
  const I = measured ? measured.input_i : (opts.loudnormTargetI ?? -16).toString();
  const TP = measured ? measured.input_tp : (opts.loudnormTargetTP ?? -1.5).toString();
  const LRA = measured ? measured.input_lra : (opts.loudnormTargetLRA ?? 11).toString();

  let filter = "loudnorm=I=" + I + ":TP=" + TP + ":LRA=" + (opts.loudnormTargetLRA ?? 11);

  if (measured) {
    filter += ":measured_I=" + measured.input_i;
    filter += ":measured_TP=" + measured.input_tp;
    filter += ":measured_LRA=" + measured.input_lra;
    filter += ":measured_thresh=" + measured.input_thresh;
    filter += ":offset=" + measured.target_offset;
    filter += ":print_format=summary";
  } else {
    filter += ":print_format=json";
  }

  return filter;
}

export async function renderClips(ctx: RenderContext): Promise<RenderResult> {
  const results = [];
  const errors = [];

  for (const stmt of ctx.statements) {
    const durationSec = (stmt.endMs - stmt.startMs) / 1000;
    const isShort = durationSec < 0.5;

    const boundsHash = createHash("sha256")
      .update(stmt.startMs + "|" + stmt.endMs)
      .digest("hex")
      .slice(0, 12);

    const outPath = ctx.outDir + "/" + stmt.id + "_" + boundsHash + ".mp3";
    const metaPath = outPath + ".meta.json";

    try {
      const [outStat, metaContent] = await Promise.all([
        fs.stat(outPath).catch(() => null),
        fs.readFile(metaPath, "utf8").catch(() => null),
      ]);
      if (outStat && metaContent) {
        const meta = JSON.parse(metaContent);
        if (meta.boundsHash === boundsHash) {
          results.push({ id: stmt.id, clipPath: outPath, bytes: outStat.size, startMs: stmt.startMs, endMs: stmt.endMs, boundsHash });
          continue;
        }
      }
    } catch {}

    await fs.mkdir(dirname(outPath), { recursive: true });

    const loudnormI = ctx.opts.loudnormTargetI ?? -16;
    const loudnormTP = ctx.opts.loudnormTargetTP ?? -1.5;
    const loudnormLRA = ctx.opts.loudnormTargetLRA ?? 11;

    const opts = {
      loudnormTargetI: loudnormI,
      loudnormTargetTP: loudnormTP,
      loudnormTargetLRA: loudnormLRA,
    };

    if (isShort) {
      // Peak-normalize fallback for sub-0.5s clips using same targets
      const args = [
        "-hide_banner", "-nostdin",
        "-ss", String(stmt.startMs / 1000),
        "-t", String((stmt.endMs - stmt.startMs) / 1000),
        "-i", stmt.sourcePath,
        "-af", `loudnorm=I=${loudnormI}:TP=${loudnormTP}:LRA=${loudnormLRA}`,
        "-ac", "1",
        "-c:a", "libmp3lame",
        "-q:a", "4",
        "-ar", "44100",
        "-y", outPath
      ];

      await runFfmpeg(FFMPEG, args);
      const stat = await fs.stat(outPath);
      await fs.writeFile(metaPath, JSON.stringify({ boundsHash, short: true }));
      results.push({ id: stmt.id, clipPath: outPath, bytes: stat.size, startMs: stmt.startMs, endMs: stmt.endMs, boundsHash });
    } else {
      const filter1 = buildLoudnormFilter({ loudnormTargetI: loudnormI, loudnormTargetTP: loudnormTP, loudnormTargetLRA: loudnormLRA });
      const pass1Args = [
        "-hide_banner", "-nostdin",
        "-ss", String(stmt.startMs / 1000),
        "-t", String((stmt.endMs - stmt.startMs) / 1000),
        "-i", stmt.sourcePath,
        "-af", filter1,
        "-f", "null", "-"
      ];

      let pass1Out = "";
      await runFfmpeg(FFMPEG, pass1Args, undefined, (out) => pass1Out += out);

      const measured = parseLoudnormOutput(pass1Out);
      if (!measured) {
        errors.push("Failed to parse loudnorm pass 1 for " + stmt.id);
        continue;
      }

      const filter2 = buildLoudnormFilter(
        { loudnormTargetI: loudnormI, loudnormTargetTP: loudnormTP, loudnormTargetLRA: loudnormLRA },
        { input_i: measured.input_i, input_tp: measured.input_tp, input_lra: measured.input_lra, input_thresh: measured.input_thresh, target_offset: measured.target_offset }
      );

      const pass2Args = [
        "-hide_banner", "-nostdin",
        "-ss", String(stmt.startMs / 1000),
        "-t", String((stmt.endMs - stmt.startMs) / 1000),
        "-i", stmt.sourcePath,
        "-af", filter2,
        "-ac", "1",
        "-c:a", "libmp3lame",
        "-q:a", "4",
        "-ar", "44100",
        "-y", outPath
      ];

      await runFfmpeg(FFMPEG, pass2Args);
      const stat = await fs.stat(outPath);
      await fs.writeFile(metaPath, JSON.stringify({ boundsHash }));
      results.push({ id: stmt.id, clipPath: outPath, bytes: stat.size, startMs: stmt.startMs, endMs: stmt.endMs, boundsHash });
    }
  }

  return { statements: results, errors };
}