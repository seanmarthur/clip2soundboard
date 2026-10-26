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
