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
  fuzz?: number; // fuzziness window in seconds
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

/**
 * Apply fuzziness re-run: snap statement edges to nearest valley candidates within ±fuzzMs.
 * - Each edge snaps to the nearest stored valley candidate within the fuzz window
 * - Clamps: never past midpoint to neighbour; min/max-ms applied after snap
 * - Human-edited statements skipped unless force=true
 * - Detection-time candidates are the only source of truth
 */
function applyFuzz(
  statements: SidecarStatement[],
  fuzzMs: number,
  minMs: number,
  maxMs: number,
  force: boolean
): void {
  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    if (stmt.edited && !force) continue;

    const candidates = stmt.candidates;
    const onsetValley = candidates.onsetValleyMs;
    const offsetValley = candidates.offsetValleyMs;
    const internalValleys = candidates.internalValleysMs || [];

    // Determine neighbour midpoints for clamping
    const prevEnd = i > 0 ? statements[i - 1].endMs : -Infinity;
    const nextStart = i < statements.length - 1 ? statements[i + 1].startMs : Infinity;
    const prevMid = (prevEnd + stmt.startMs) / 2;
    const nextMid = (stmt.endMs + nextStart) / 2;

    // Snap startMs to nearest onset valley within ±fuzzMs
    let newStart = stmt.startMs;
    if (onsetValley !== null && Math.abs(onsetValley - stmt.startMs) <= fuzzMs) {
      const candidate = onsetValley;
      // Clamp: never past midpoint to previous statement
      newStart = Math.max(candidate, prevMid);
    }

    // Snap endMs to nearest offset valley within ±fuzzMs
    let newEnd = stmt.endMs;
    if (offsetValley !== null && Math.abs(offsetValley - stmt.endMs) <= fuzzMs) {
      const candidate = offsetValley;
      // Clamp: never past midpoint to next statement
      newEnd = Math.min(candidate, nextMid);
    }

    // Also consider internal valleys for potential splits (if fuzz allows)
    // For now, internal valleys are used when an edge snap would cross one
    // but we don't split statements in this slice - that's for future work

    // Apply min/max-ms clamps after snap
    newStart = Math.max(newStart, stmt.endMs - maxMs); // ensure length <= maxMs
    newEnd = Math.min(newEnd, stmt.startMs + maxMs);
    // Ensure length >= minMs
    if (newEnd - newStart < minMs) {
      // Try to expand equally, preferring the snapped edge
      const deficit = minMs - (newEnd - newStart);
      newStart = Math.max(newStart - deficit / 2, prevMid);
      newEnd = Math.min(newEnd + deficit / 2, nextMid);
    }

    // Final clamp to neighbour midpoints
    newStart = Math.max(newStart, prevMid);
    newEnd = Math.min(newEnd, nextMid);

    // Only apply if valid
    if (newEnd > newStart && newEnd - newStart >= minMs && newEnd - newStart <= maxMs) {
      stmt.startMs = newStart;
      stmt.endMs = newEnd;
      stmt.note = stmt.note
        ? `${stmt.note} | fuzz-snapped: ${newStart}..${newEnd}`
        : `fuzz-snapped: ${newStart}..${newEnd}`;
    }
  }
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

  // Apply fuzziness re-run: snap edges to nearest valley candidates within ±fuzz
  if (fuzz && fuzz > 0) {
    applyFuzz(merged, fuzz * 1000, minMs, maxMs, force);
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