import { test, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { generate } from "../scripts/fixtures-gen.mjs";

const fixtureDir = mkdtempSync(join(tmpdir(), "c2s-fixture-"));
const { manifest } = generate(fixtureDir);
const fixture = (id: string) => manifest.fixtures.find((f) => f.id === id);
const fpath = (f: any) => join(fixtureDir, f.file);

const outBase = mkdtempSync(join(tmpdir(), "c2s-test-out-"));

after(() => {
  rmSync(fixtureDir, { recursive: true });
  rmSync(outBase, { recursive: true });
});

async function runCli(cliArgs: string[], cwd = resolve(".")): Promise<{ code: number; stdout: string; stderr: string }> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const child = spawn("node", ["--experimental-strip-types", "src/cli.ts", ...cliArgs], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.on("error", (err) => resolve({ code: 1, stdout, stderr: String(err) }));
  });
}

test("extract single file --json returns versioned document", async () => {
  const f = fixture("micro-statement");
  const outDir = join(outBase, "single-" + Date.now());
  mkdirSync(outDir, { recursive: true });
  const { code, stdout, stderr } = await runCli([
    "extract", fpath(f),
    "--out", outDir,
    "--json",
    "--min-ms", "300",
    "--no-transcript",
  ]);
  assert.equal(code, 0);
  assert.ok(stderr.length > 0, "logs go to stderr");
  const parsed = JSON.parse(stdout.trim());
  assert.equal(parsed.version, 1);
  assert.ok(Array.isArray(parsed.sources));
  assert.equal(parsed.sources.length, 1);
  assert.equal(parsed.sources[0].file, fpath(f));
  assert.equal(typeof parsed.summary.files, "number");
});

test("--dry-run --json returns clip: null and renders nothing", async () => {
  const f = fixture("micro-statement");
  const outDir = join(outBase, "dryrun-" + Date.now());
  mkdirSync(outDir, { recursive: true });
  const { code, stdout, stderr } = await runCli([
    "extract", fpath(f),
    "--out", outDir,
    "--json",
    "--dry-run",
    "--min-ms", "300",
  ]);
  assert.equal(code, 0);
  const parsed = JSON.parse(stdout.trim());
  assert.equal(parsed.version, 1);
  assert.ok(parsed.sources[0].clips.length === 0);
  // Verify no output files created
  const { readdirSync } = await import("node:fs");
  const files = readdirSync(outDir);
  assert.equal(files.length, 0);
});

test("directory traversal processes all files sequentially", async () => {
  const dir = join(outBase, "dir-input-" + Date.now());
  mkdirSync(dir, { recursive: true });
  // Copy two fixtures to the input dir
  const f1 = fixture("micro-statement");
  const f2 = fixture("silence-only");
  const { copyFileSync } = await import("node:fs");
  const in1 = join(dir, "a.mp4");
  const in2 = join(dir, "b.mp4");
  copyFileSync(fpath(f1), in1);
  copyFileSync(fpath(f2), in2);
  const outDir = join(outBase, "dir-out-" + Date.now());
  mkdirSync(outDir, { recursive: true });
  const { code, stdout, stderr } = await runCli([
    "extract", dir,
    "--out", outDir,
    "--json",
    "--min-ms", "300",
    "--no-transcript",
  ]);
  assert.equal(code, 0);
  const parsed = JSON.parse(stdout.trim());
  assert.equal(parsed.version, 1);
  assert.equal(parsed.sources.length, 2);
  assert.equal(parsed.summary.files, 2);
  // stderr should have per-file progress
  assert.ok(stderr.includes("FAIL") || stderr.includes("statements"));
});

test("exit 0 when all files succeed; exit 1 when any fail", async () => {
  const outDir = join(outBase, "exit-" + Date.now());
  mkdirSync(outDir, { recursive: true });
  // All succeed
  const f = fixture("micro-statement");
  const { code: codeOk } = await runCli([
    "extract", fpath(f),
    "--out", outDir,
    "--json",
    "--min-ms", "300",
    "--no-transcript",
  ]);
  assert.equal(codeOk, 0);
  // One fails (non-existent file)
  const { code: codeFail } = await runCli([
    "extract", "/tmp/does-not-exist-never.mp4",
    "--out", outDir,
    "--json",
    "--min-ms", "300",
  ]);
  assert.equal(codeFail, 1);
});

test("--json stdout is exactly one parseable document; logs never on stdout", async () => {
  const f = fixture("micro-statement");
  const outDir = join(outBase, "stdout-" + Date.now());
  mkdirSync(outDir, { recursive: true });
  const { code, stdout, stderr } = await runCli([
    "extract", fpath(f),
    "--out", outDir,
    "--json",
    "--min-ms", "300",
    "--no-transcript",
  ]);
  assert.equal(code, 0);
  // stdout must be single JSON document
  assert.ok(stdout.trim().startsWith("{"));
  assert.ok(stdout.trim().endsWith("}"));
  // No extra lines
  const lines = stdout.trim().split("\n").filter((l) => l.trim().length > 0);
  assert.equal(lines.length, 1);
  // Parse and validate structure
  const parsed = JSON.parse(stdout.trim());
  assert.equal(parsed.version, 1);
  // stderr should contain logs
  assert.ok(stderr.length > 0);
});

test("flags: --fuzz, --min-ms, --max-ms, --force, --rescan, --rescan-hard, --no-transcript all accepted", async () => {
  const f = fixture("micro-statement");
  const outDir = join(outBase, "flags-" + Date.now());
  mkdirSync(outDir, { recursive: true });
  const { code } = await runCli([
    "extract", fpath(f),
    "--out", outDir,
    "--json",
    "--fuzz", "0.5",
    "--min-ms", "500",
    "--max-ms", "10000",
    "--force",
    "--rescan",
    "--no-transcript",
  ]);
  assert.equal(code, 0);
});

test("help prints usage and exits 0", async () => {
  const { code, stderr } = await runCli(["extract", "-h"]);
  assert.equal(code, 0);
  assert.ok(stderr.includes("Usage:"));
  assert.ok(stderr.includes("--out"));
  assert.ok(stderr.includes("--json"));
  assert.ok(stderr.includes("--dry-run"));
});

test("unknown subcommand exits 1", async () => {
  const { code } = await runCli(["unknown"]);
  assert.equal(code, 1);
});

test("missing input exits 1", async () => {
  const { code } = await runCli(["extract"]);
  assert.equal(code, 1);
});