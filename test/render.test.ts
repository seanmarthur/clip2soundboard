import { test, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { renderClip, renderClips, clipRenderHash, measureLoudness } from "../src/render.ts";
import type { SidecarV1 } from "../src/sidecar.ts";

const require = createRequire(import.meta.url);
const FFMPEG = require("ffmpeg-static");

const testDir = mkdtempSync(join(tmpdir(), "c2s-render-test-"));

after(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function createSyntheticAudio(path: string, durationSec: number): void {
  const res = spawnSync(
    FFMPEG,
    [
      "-hide_banner",
      "-nostdin",
      "-f", "lavfi",
      "-i", `sine=frequency=440:duration=${durationSec}`,
      "-ar", "16000",
      "-ac", "1",
      "-y",
      path,
    ],
    { encoding: "utf8" }
  );
  if (res.status !== 0) {
    throw new Error(`Failed to create synthetic audio: ${res.stderr}`);
  }
}

function probeDurationSec(mp3Path: string): number {
  const res = spawnSync(
    FFMPEG,
    ["-hide_banner", "-nostdin", "-i", mp3Path, "-f", "null", "-"],
    { encoding: "utf8" }
  );
  const match = res.stderr.match(/size=\s*N\/A\s*time=\s*(\d+):(\d+):([\d.]+)/);
  if (!match) {
    const durMatch = res.stderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
    if (!durMatch) throw new Error(`Could not parse duration from stderr: ${res.stderr}`);
    return parseFloat(durMatch[1]) * 3600 + parseFloat(durMatch[2]) * 60 + parseFloat(durMatch[3]);
  }
  return parseFloat(match[1]) * 3600 + parseFloat(match[2]) * 60 + parseFloat(match[3]);
}

test("Two-pass loudnorm lands -16 LUFS ±0.5 on a 3 s Clip and produces playable mp3", async () => {
  const sourcePath = join(testDir, "source_3s.wav");
  createSyntheticAudio(sourcePath, 5);

  const outPath = join(testDir, "clip_3s.mp3");
  const res = await renderClip(sourcePath, { startMs: 1000, endMs: 4000 }, outPath);

  assert.equal(res.method, "loudnorm");
  assert.ok(existsSync(outPath));
  assert.ok(statSync(outPath).size > 0);

  const measured = await measureLoudness(outPath);
  // -16 LUFS ±0.5
  assert.ok(
    measured.inputI >= -16.5 && measured.inputI <= -15.5,
    `Measured ${measured.inputI} LUFS not within -16 ±0.5 LUFS`
  );

  // Byte-length sanity: Clip duration within one encoder frame of Range length (3000 ms)
  // At 44.1 kHz, one MP3 frame is 1152 samples (~26.1 ms)
  const durationSec = probeDurationSec(outPath);
  const diffMs = Math.abs(durationSec * 1000 - 3000);
  assert.ok(
    diffMs <= (1152 / 44100) * 1000 + 5,
    `Duration difference ${diffMs} ms exceeds one MP3 encoder frame`
  );
});

test("Sub-0.5 s Statement gets peak-normalize fallback, no filtergraph error", async () => {
  const sourcePath = join(testDir, "source_sub05.wav");
  createSyntheticAudio(sourcePath, 2);

  const outPath = join(testDir, "clip_03s.mp3");
  // 300 ms Statement (< 500 ms)
  const res = await renderClip(sourcePath, { startMs: 200, endMs: 500 }, outPath);

  assert.equal(res.method, "peak-normalize");
  assert.ok(existsSync(outPath));
  assert.ok(statSync(outPath).size > 0);

  // Byte-length sanity: Clip duration within one encoder frame of Range length (300 ms)
  const durationSec = probeDurationSec(outPath);
  const diffMs = Math.abs(durationSec * 1000 - 300);
  assert.ok(
    diffMs <= (1152 / 44100) * 1000 + 5,
    `Duration difference ${diffMs} ms exceeds one MP3 encoder frame`
  );
});

test("Unchanged bounds skip re-render; changed bounds or --force re-render", async () => {
  const sourcePath = join(testDir, "source_multi.wav");
  createSyntheticAudio(sourcePath, 6);

  const sidecar: SidecarV1 = {
    version: 1,
    source: {
      path: sourcePath,
      sha256: "dummy-hash",
      durationMs: 6000,
    },
    model: {
      sileroSha256: "a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28",
    },
    statements: [
      {
        id: "s01",
        startMs: 1000,
        endMs: 4000,
        detection: { startMs: 1000, endMs: 4000, peakProb: 0.99 },
        candidates: { onsetValleyMs: null, offsetValleyMs: null, internalValleysMs: [] },
        transcript: null,
        clip: null,
        edited: false,
        note: null,
      },
      {
        id: "s02",
        startMs: 4200,
        endMs: 4500, // 300ms, peak-normalize fallback
        detection: { startMs: 4200, endMs: 4500, peakProb: 0.99 },
        candidates: { onsetValleyMs: null, offsetValleyMs: null, internalValleysMs: [] },
        transcript: null,
        clip: null,
        edited: false,
        note: null,
      },
    ],
  };

  const outDir = join(testDir, "clips_batch");

  // Initial render: both statements rendered
  const r1 = await renderClips(sidecar, outDir);
  assert.equal(r1.rendered, 2);
  assert.equal(r1.skipped, 0);
  assert.ok(existsSync(join(outDir, "s01.mp3")));
  assert.ok(existsSync(join(outDir, "s02.mp3")));
  assert.equal(sidecar.statements[0].clip?.renderedFrom, clipRenderHash(sidecar.statements[0], sourcePath));
  assert.equal(sidecar.statements[1].clip?.renderedFrom, clipRenderHash(sidecar.statements[1], sourcePath));

  const s01MtimeInitial = statSync(join(outDir, "s01.mp3")).mtimeMs;
  const s02MtimeInitial = statSync(join(outDir, "s02.mp3")).mtimeMs;

  // Unchanged run: both skipped
  const r2 = await renderClips(sidecar, outDir);
  assert.equal(r2.rendered, 0);
  assert.equal(r2.skipped, 2);
  assert.equal(statSync(join(outDir, "s01.mp3")).mtimeMs, s01MtimeInitial);
  assert.equal(statSync(join(outDir, "s02.mp3")).mtimeMs, s02MtimeInitial);

  // Changed bounds on s01: s01 re-rendered, s02 skipped
  sidecar.statements[0].startMs = 1200;
  const r3 = await renderClips(sidecar, outDir);
  assert.equal(r3.rendered, 1);
  assert.equal(r3.skipped, 1);
  assert.notEqual(statSync(join(outDir, "s01.mp3")).mtimeMs, s01MtimeInitial);
  assert.equal(statSync(join(outDir, "s02.mp3")).mtimeMs, s02MtimeInitial);

  // --force re-renders both even if bounds unchanged
  const r4 = await renderClips(sidecar, outDir, { force: true });
  assert.equal(r4.rendered, 2);
  assert.equal(r4.skipped, 0);
});
