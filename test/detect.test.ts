// Seam 1: detectStatements(sourcePath) -> Statement[].
// Expected bounds come from the fixture ground truth (independent source of
// truth), not from the implementation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generate, type Fixture } from "../scripts/fixtures-gen.mjs";
import { detectStatements } from "../src/detect.ts";

const { manifest, outDir } = generate(join(tmpdir(), "c2s-fixtures"));

const fixture = (id: string) => {
  const f = manifest.fixtures.find((x) => x.id === id);
  if (!f) throw new Error(`no fixture ${id}`);
  return f;
};
const path = (f: Fixture) => join(outDir, f.file);
const TOLERANCE_MS = 60;

for (const f of manifest.fixtures) {
  test(`${f.id}: Statement count`, async () => {
    const statements = await detectStatements(path(f));
    assert.equal(statements.length, f.statements.length, JSON.stringify(statements));
  });
}

for (const f of manifest.fixtures) {
  test(`${f.id}: boundaries within ±${TOLERANCE_MS} ms`, async (t) => {
    const statements = await detectStatements(path(f));
    if (statements.length !== f.statements.length) return t.skip("count mismatch, covered above");
    statements.forEach((s, i) => {
      const truth = f.statements[i];
      assert.ok(
        Math.abs(s.startMs - truth.startMs) <= TOLERANCE_MS,
        `start ${s.startMs} vs ${truth.startMs}`,
      );
      assert.ok(Math.abs(s.endMs - truth.endMs) <= TOLERANCE_MS, `end ${s.endMs} vs ${truth.endMs}`);
    });
  });
}

test("detection is deterministic across re-runs", async () => {
  const f = fixture("noise-floor");
  const first = await detectStatements(path(f));
  const second = await detectStatements(path(f));
  assert.deepEqual(second, first);
});

test("every Statement carries valley candidates for the Fuzziness re-run", async () => {
  const f = fixture("split-statement");
  const [s] = await detectStatements(path(f));
  assert.equal(typeof s.candidates.onsetValleyMs, "number");
  assert.equal(typeof s.candidates.offsetValleyMs, "number");
  assert.ok(s.detection.endMs >= s.detection.startMs);
});

test("sub-voice-band noise alone yields no Statement", async () => {
  const statements = await detectStatements(path(fixture("silence-only")));
  assert.deepEqual(statements, []);
});
