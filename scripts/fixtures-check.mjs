// Fixture-backed invariants for the Detect core (ticket #11 / slice 1).
// Asserts the public seam only: detectStatements(sourcePath).
//
// Usage: node scripts/fixtures-check.mjs
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generate } from "./fixtures-gen.mjs";
import { detectStatements } from "../src/detect.ts";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const PINNED_MODEL_SHA256 = "a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28";
const TOLERANCE_MS = 60;

let failures = 0;
const assert = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const modelFile = join(dirname(require.resolve("@ricky0123/vad-node")), "silero_vad.onnx");
const hash = createHash("sha256").update(readFileSync(modelFile)).digest("hex");
assert("silero model hash pinned", hash === PINNED_MODEL_SHA256, hash);

const { manifest, outDir } = generate(join(here, "fixtures"));

for (const fixture of manifest.fixtures) {
  const source = join(outDir, fixture.file);
  const detected = await detectStatements(source);
  const expected = fixture.statements.map((s) => `${s.startMs}..${s.endMs} ms`).join(", ") || "none";
  assert(
    `${fixture.id}: Statement count`,
    detected.length === fixture.statements.length,
    `expected ${fixture.statements.length} (${expected}), got ${JSON.stringify(detected)}`,
  );
  if (detected.length !== fixture.statements.length) continue;

  const detail = [];
  let close = true;
  detected.forEach((d, i) => {
    const truth = fixture.statements[i];
    const dStart = d.startMs - truth.startMs;
    const dEnd = d.endMs - truth.endMs;
    detail.push(`Δstart ${dStart} ms, Δend ${dEnd} ms`);
    if (Math.abs(dStart) > TOLERANCE_MS || Math.abs(dEnd) > TOLERANCE_MS) close = false;
  });
  assert(`${fixture.id}: boundaries within ±${TOLERANCE_MS} ms`, close, detail.join("; "));
  assert(
    `${fixture.id}: deterministic across re-runs`,
    JSON.stringify(await detectStatements(source)) === JSON.stringify(detected),
  );
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
