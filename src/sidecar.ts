import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { detectStatements } from "./detect.ts";

export interface SidecarV1 {
  version: 1;
  source: { path: string; sha256: string; durationMs: number };
  model: { sileroSha256: string };
  statements: SidecarStatement[];
}

export interface SidecarStatement {
  id: string;
  startMs: number;
  endMs: number;
  detection: { startMs: number; endMs: number; peakProb: number };
  candidates: {
    onsetValleyMs: number | null;
    offsetValleyMs: number | null;
    internalValleysMs: number[];
  };
  transcript: { text: string; model: string; at: number } | null;
  clip: { path: string; bytes: number; renderedFrom: string } | null;
  edited: boolean;
  note: string | null;
}

export interface RangeOptions {
  force?: boolean;
  rescan?: boolean;
  rescanHard?: boolean;
  minMs?: number;
  maxMs?: number;
  fuzz?: number;
}

const PINNED_SILERO_SHA256 = "a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28";

function slugFromPath(p: string): string {
  return p.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") ?? "source";
}

function boundsHash(s: { startMs: number; endMs: number }): string {
  return createHash("sha256").update(`${s.startMs}|${s.endMs}`).digest("hex").slice(0, 12);
}

function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function ensureDir(p: string) { mkdirSync(dirname(p), { recursive: true }); }

function loadSidecar(path: string): SidecarV1 | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as SidecarV1;
}

function saveSidecar(path: string, data: SidecarV1) {
  ensureDir(path);
  writeFileSync(path, JSON.stringify(data, null, 1));
}

export async function deriveRanges(
  sourcePath: string,
  outDir: string,
  options: RangeOptions = {}
): Promise<SidecarV1> {
  const { force = false, rescan = false, rescanHard = false, minMs = 1000, maxMs = 30000, fuzz = 0 } = options;
  const slug = slugFromPath(sourcePath);
  const sidecarPath = join(outDir, `${slug}.ranges.json`);

  const statements = await detectStatements(sourcePath, {
    positiveThreshold: 0.5,
    minSpeechFrames: 3,
    redemptionFrames: 10,
    cleanup: true,
  });

  const sourceSha = fileSha256(sourcePath);
  const durationMs = statements.length
    ? statements[statements.length - 1].endMs
    : 0;

  // On rescan-hard: discard everything; on rescan: load existing to preserve edits
  const existing = rescanHard ? null : loadSidecar(sidecarPath);
  const isRescan = rescan || rescanHard;

  const merged: SidecarStatement[] = [];
  let nextId = 1;

  for (const s of statements) {
    const len = s.endMs - s.startMs;
    if (len < minMs || len > maxMs) continue;

    // Match existing by ID (not available on incoming) then by proximity
    // Wider window for edited statements so human edits survive re-detection
    let existingStmt = existing?.statements.find((es) => {
      const window = es.edited ? 500 : 200;
      return Math.abs(es.startMs - s.startMs) <= window && Math.abs(es.endMs - s.endMs) <= window;
    });

    if (!isRescan && existingStmt) {
      // Normal run: edited protection applies
      if (existingStmt.edited && !force) {
        merged.push({
          ...existingStmt,
          note: existingStmt.note
            ? `${existingStmt.note} | re-detected: ${s.startMs}..${s.endMs}`
            : `re-detected: ${s.startMs}..${s.endMs}`,
        });
        continue;
      }
      // Not edited or forced: update bounds, keep ID and other fields
      merged.push({
        ...existingStmt,
        startMs: s.startMs,
        endMs: s.endMs,
        detection: { startMs: s.detection.startMs, endMs: s.detection.endMs, peakProb: s.peakProb },
        candidates: s.candidates,
        note: existingStmt.note ? `${existingStmt.note} | re-detected: ${s.startMs}..${s.endMs}` : null,
      });
      continue;
    }

    if (isRescan && existingStmt) {
      // Rescan (not hard): preserve edited flag, update bounds unless edited
      if (existingStmt.edited) {
        merged.push({
          ...existingStmt,
          note: existingStmt.note
            ? `${existingStmt.note} | re-detected: ${s.startMs}..${s.endMs}`
            : `re-detected: ${s.startMs}..${s.endMs}`,
        });
        continue;
      }
      // Not edited: update bounds
      merged.push({
        ...existingStmt,
        startMs: s.startMs,
        endMs: s.endMs,
        detection: { startMs: s.detection.startMs, endMs: s.detection.endMs, peakProb: s.peakProb },
        candidates: s.candidates,
        note: existingStmt.note ? `${existingStmt.note} | re-detected: ${s.startMs}..${s.endMs}` : null,
      });
      continue;
    }

    if (isRescan && !existingStmt) {
      // Rescan: new statement not in existing - create with fresh ID
      merged.push({
        id: `s${String(nextId++).padStart(2, "0")}`,
        startMs: s.startMs,
        endMs: s.endMs,
        detection: { startMs: s.detection.startMs, endMs: s.detection.endMs, peakProb: s.peakProb },
        candidates: s.candidates,
        transcript: null,
        clip: null,
        edited: false,
        note: null,
      });
      continue;
    }

    // New statement (no existing match)
    merged.push({
      id: `s${String(nextId++).padStart(2, "0")}`,
      startMs: s.startMs,
      endMs: s.endMs,
      detection: { startMs: s.detection.startMs, endMs: s.detection.endMs, peakProb: s.peakProb },
      candidates: s.candidates,
      transcript: null,
      clip: null,
      edited: false,
      note: null,
    });
  }

  // Rescan-hard: drop all edits and notes
  if (rescanHard) {
    merged.forEach((m) => { m.edited = false; m.note = null; });
  }

  const sidecar: SidecarV1 = {
    version: 1,
    source: { path: sourcePath, sha256: fileSha256(sourcePath), durationMs },
    model: { sileroSha256: "a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28" },
    statements: merged,
  };

  saveSidecar(sidecarPath, sidecar);
  return sidecar;
}

export { slugFromPath, boundsHash, fileSha256, loadSidecar };