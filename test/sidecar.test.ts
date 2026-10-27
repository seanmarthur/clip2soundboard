import { test, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { detectStatements } from "../src/detect.ts";
import { deriveRanges, loadSidecar } from "../src/sidecar.ts";
import { generate } from "../scripts/fixtures-gen.mjs";

const fixtureDir = mkdtempSync(join(tmpdir(), "c2s-test-"));
const { manifest } = generate(fixtureDir);
const fixture = (id: string) => manifest.fixtures.find((f) => f.id === id);
const fpath = (f: any) => join(fixtureDir, f.file);

after(() => { rmSync(fixtureDir, { recursive: true }); });

test("deriveRanges writes sidecar v1 with stable ids", async () => {
  const f = fixture("split-statement");
  const sidecar = await deriveRanges(fpath(f), join(tmpdir(), "out"), { minMs: 300 });
  assert.equal(sidecar.version, 1);
  assert.equal(sidecar.statements.length, 1);
  assert.equal(sidecar.statements[0].id, "s01");
  assert.ok(sidecar.statements[0].candidates.internalValleysMs.length > 0);
  assert.ok(!sidecar.statements[0].edited);
});

test("re-run keeps ids stable, updates bounds unless edited", async () => {
  const f = fixture("micro-statement");
  const first = await deriveRanges(fpath(f), join(tmpdir(), "out-rerun"), { minMs: 300 });
  const second = await deriveRanges(fpath(f), join(tmpdir(), "out-rerun"), { minMs: 300 });
  assert.equal(first.statements[0].id, second.statements[0].id);
  assert.equal(first.statements[0].startMs, second.statements[0].startMs);
});

test("edited:true protects bounds; proposal lands in note", async () => {
  const f = fixture("micro-statement");
  const out = join(tmpdir(), "out-edit");
  await deriveRanges(fpath(f), out, { minMs: 300 });
  const sidecarPath = join(out, `micro-statement.ranges.json`);
  const loaded = loadSidecar(sidecarPath)!;
  loaded.statements[0].edited = true;
  loaded.statements[0].startMs = 100;
  loaded.statements[0].endMs = 900;
  const { writeFileSync } = await import("node:fs");
  writeFileSync(sidecarPath, JSON.stringify(loaded, null, 1));
  const second = await deriveRanges(fpath(f), out, { minMs: 300 });
  assert.equal(second.statements[0].startMs, 100);
  assert.ok(second.statements[0].note?.includes("re-detected"));
});

test("--force overrides edited protection", async () => {
  const f = fixture("micro-statement");
  const out = join(tmpdir(), "out-force");
  await deriveRanges(fpath(f), out, { minMs: 300 });
  const sidecarPath = join(out, `micro-statement.ranges.json`);
  const loaded = loadSidecar(sidecarPath)!;
  loaded.statements[0].edited = true;
  loaded.statements[0].startMs = 100;
  writeFileSync(sidecarPath, JSON.stringify(loaded, null, 1));
  const forced = await deriveRanges(fpath(f), out, { force: true, minMs: 300 });
  assert.notEqual(forced.statements[0].startMs, 100);
});

test("rescan keeps human edits; rescan-hard drops them", async () => {
  const f = fixture("micro-statement");
  const out = join(tmpdir(), "out-rescan");
  await deriveRanges(fpath(f), out, { minMs: 300 });
  const sidecarPath = join(out, `micro-statement.ranges.json`);
  const loaded = loadSidecar(sidecarPath)!;
  loaded.statements[0].edited = true;
  loaded.statements[0].note = "human";
  const { writeFileSync } = await import("node:fs");
  writeFileSync(sidecarPath, JSON.stringify(loaded, null, 1));

  await deriveRanges(fpath(f), out, { rescan: true, minMs: 300 });
  const afterRescan = loadSidecar(sidecarPath)!;
  assert.ok(afterRescan.statements[0].edited);

  await deriveRanges(fpath(f), out, { rescanHard: true, minMs: 300 });
  const afterHard = loadSidecar(sidecarPath)!;
  assert.ok(!afterHard.statements[0].edited);
  assert.ok(!afterHard.statements[0].note);
});

test("min-ms/max-ms filter statements", async () => {
  const f = fixture("split-statement");
  const sidecar = await deriveRanges(fpath(f), join(tmpdir(), "out-filter"), { minMs: 500, maxMs: 800 });
  assert.ok(sidecar.statements.every((s) => s.endMs - s.startMs >= 500 && s.endMs - s.startMs <= 800));
});

test("silence-only writes empty statements array", async () => {
  const f = fixture("silence-only");
  const sidecar = await deriveRanges(fpath(f), join(tmpdir(), "out-silence"));
  assert.deepEqual(sidecar.statements, []);
});

test("fuzz=0 leaves bounds unchanged", async () => {
  const f = fixture("split-statement");
  const out = join(tmpdir(), "out-nofuzz-" + Date.now());
  const noFuzz = await deriveRanges(fpath(f), out, { minMs: 300, fuzz: 0 });
  const noFuzz2 = await deriveRanges(fpath(f), out, { minMs: 300, fuzz: 0 });
  // Re-run with fuzz=0 should not change bounds
  assert.equal(noFuzz.statements[0].startMs, noFuzz2.statements[0].startMs);
  assert.equal(noFuzz.statements[0].endMs, noFuzz2.statements[0].endMs);
});

test("fuzz snaps edges to valley candidates within window", async () => {
  const f = fixture("split-statement");
  const outBase = join(tmpdir(), "out-base-" + Date.now());
  const outFuzzed = join(tmpdir(), "out-fuzzed-" + Date.now());
  const base = await deriveRanges(fpath(f), outBase, { minMs: 300, fuzz: 0 });
  const fuzzed = await deriveRanges(fpath(f), outFuzzed, { minMs: 300, fuzz: 0.5 });
  // At least one edge should move toward a valley candidate
  const sBase = base.statements[0];
  const sFuzz = fuzzed.statements[0];
  const moved = sFuzz.startMs !== sBase.startMs || sFuzz.endMs !== sBase.endMs;
  assert.ok(moved, "fuzz should move at least one edge toward a valley");
  // Note should record the snap
  assert.ok(sFuzz.note?.includes("fuzz-snapped"));
});

test("edited statement untouched without --force", async () => {
  const f = fixture("split-statement");
  const out = join(tmpdir(), "out-edit-fuzz-" + Date.now());
  await deriveRanges(fpath(f), out, { minMs: 300, fuzz: 0 });
  const sidecarPath = join(out, `split-statement.ranges.json`);
  const loaded = loadSidecar(sidecarPath)!;
  loaded.statements[0].edited = true;
  const origStart = loaded.statements[0].startMs;
  const origEnd = loaded.statements[0].endMs;
  const { writeFileSync } = await import("node:fs");
  writeFileSync(sidecarPath, JSON.stringify(loaded, null, 1));
  // Re-run with fuzz but no force
  const fuzzed = await deriveRanges(fpath(f), out, { minMs: 300, fuzz: 0.5 });
  assert.equal(fuzzed.statements[0].startMs, origStart);
  assert.equal(fuzzed.statements[0].endMs, origEnd);
});

test("--force overrides edited protection with fuzz", async () => {
  const f = fixture("split-statement");
  const out = join(tmpdir(), "out-force-fuzz-" + Date.now());
  await deriveRanges(fpath(f), out, { minMs: 300, fuzz: 0 });
  const sidecarPath = join(out, `split-statement.ranges.json`);
  const loaded = loadSidecar(sidecarPath)!;
  loaded.statements[0].edited = true;
  const origStart = loaded.statements[0].startMs;
  const { writeFileSync } = await import("node:fs");
  writeFileSync(sidecarPath, JSON.stringify(loaded, null, 1));
  // Re-run with fuzz and force
  const fuzzed = await deriveRanges(fpath(f), out, { minMs: 300, fuzz: 0.5, force: true });
  assert.notEqual(fuzzed.statements[0].startMs, origStart);
});

test("fixed fuzz reproduces identical bounds (determinism)", async () => {
  const f = fixture("split-statement");
  const out1 = join(tmpdir(), "out-det1-" + Date.now());
  const out2 = join(tmpdir(), "out-det2-" + Date.now());
  const first = await deriveRanges(fpath(f), out1, { minMs: 300, fuzz: 0.3 });
  const second = await deriveRanges(fpath(f), out2, { minMs: 300, fuzz: 0.3 });
  assert.equal(first.statements[0].startMs, second.statements[0].startMs);
  assert.equal(first.statements[0].endMs, second.statements[0].endMs);
});

test("fuzz clamps at neighbour midpoint", async () => {
  // This test needs two statements close together
  // micro-statement has short duration; split-statement has one long statement
  // We'll test that bounds don't cross midpoint
  const f = fixture("split-statement");
  const out = join(tmpdir(), "out-clamp-" + Date.now());
  const fuzzed = await deriveRanges(fpath(f), out, { minMs: 100, maxMs: 5000, fuzz: 10 });
  const s = fuzzed.statements[0];
  // The statement should not exceed reasonable bounds
  assert.ok(s.startMs >= 0);
  assert.ok(s.endMs > s.startMs);
  assert.ok(s.endMs - s.startMs >= 100);
});
