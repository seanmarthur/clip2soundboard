import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  copyFileSync,
  mkdirSync,
} from "node:fs";
import { generate } from "../scripts/fixtures-gen.mjs";

const execFileAsync = promisify(execFile);
const cliPath = resolve("src/cli.ts");

const fixtureDir = mkdtempSync(join(tmpdir(), "c2s-cli-test-"));
const { manifest } = generate(fixtureDir);
const fixture = (id: string) => manifest.fixtures.find((f: any) => f.id === id);
const fpath = (f: any) => join(fixtureDir, f.file);

after(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
});

async function runCli(args: string[]) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args]);
    return { code: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (err: any) {
    return {
      code: typeof err.code === "number" ? err.code : 1,
      stdout: String(err.stdout || ""),
      stderr: String(err.stderr || ""),
    };
  }
}

test("subcommand handling and help exit codes", async () => {
  // No args: exit 1 and usage on stderr
  const noArgs = await runCli([]);
  assert.equal(noArgs.code, 1);
  assert.ok(noArgs.stderr.includes("Usage: clip2soundboard"));

  // Help flags: exit 0 and usage on stderr
  const helpCmd = await runCli(["help"]);
  assert.equal(helpCmd.code, 0);
  assert.ok(helpCmd.stderr.includes("Usage: clip2soundboard"));

  const helpFlag = await runCli(["--help"]);
  assert.equal(helpFlag.code, 0);
  assert.ok(helpFlag.stderr.includes("Usage: clip2soundboard"));

  const shortHelpFlag = await runCli(["-h"]);
  assert.equal(shortHelpFlag.code, 0);
  assert.ok(shortHelpFlag.stderr.includes("Usage: clip2soundboard"));

  const extractHelp = await runCli(["extract", "--help"]);
  assert.equal(extractHelp.code, 0);
  assert.ok(extractHelp.stderr.includes("Usage: clip2soundboard"));

  const extractShortHelp = await runCli(["extract", "-h"]);
  assert.equal(extractShortHelp.code, 0);
  assert.ok(extractShortHelp.stderr.includes("Usage: clip2soundboard"));

  // Unknown subcommand: exit 1
  const unknown = await runCli(["nonexistent-subcommand"]);
  assert.equal(unknown.code, 1);
  assert.ok(unknown.stderr.includes("Unknown subcommand"));

  // extract without target: exit 1
  const extractNoTarget = await runCli(["extract"]);
  assert.equal(extractNoTarget.code, 1);
  assert.ok(extractNoTarget.stderr.includes("Usage: clip2soundboard"));
});

test("exit code 1 on non-existent input path", async () => {
  const missing = await runCli(["extract", "nonexistent-file.mp4"]);
  assert.equal(missing.code, 1);
  assert.ok(missing.stderr.includes("does not exist"));

  const missingJson = await runCli(["extract", "nonexistent-file.mp4", "--json"]);
  assert.equal(missingJson.code, 1);
  const json = JSON.parse(missingJson.stdout.trim());
  assert.equal(json.version, 1);
  assert.equal(json.sources[0].status, "error");
  assert.equal(json.summary.failures, 1);
});

test("every flag works with its documented default", async () => {
  const f = fixture("split-statement");
  const defaultOutDir = resolve("./clips");
  const expectedSidecar = join(defaultOutDir, "split-statement.ranges.json");

  // Clean before test if exists
  if (existsSync(expectedSidecar)) {
    rmSync(expectedSidecar, { force: true });
  }

  // Run with only extract and source file (using all defaults: out=./clips, fuzz=0, min-ms=1000, max-ms=30000, force=false, rescan=false, json=false, dry-run=false, no-transcript=true)
  const res = await runCli(["extract", fpath(f)]);
  assert.equal(res.code, 0);
  assert.equal(res.stdout, ""); // No logs on stdout when not --json
  assert.ok(existsSync(expectedSidecar));

  // Clean up
  rmSync(expectedSidecar, { force: true });
});

test("custom flags override defaults properly", async () => {
  const f = fixture("micro-statement");
  const customOut = mkdtempSync(join(tmpdir(), "c2s-custom-flags-"));

  const res = await runCli([
    "extract",
    fpath(f),
    "--out",
    customOut,
    "--fuzz",
    "0.1",
    "--min-ms",
    "200",
    "--max-ms",
    "15000",
    "--force",
    "--rescan",
    "--json",
    "--no-transcript",
  ]);

  assert.equal(res.code, 0);
  const json = JSON.parse(res.stdout.trim());
  assert.equal(json.version, 1);
  assert.equal(json.summary.files, 1);
  assert.equal(json.summary.statements, 1);
  assert.ok(existsSync(join(customOut, "micro-statement.ranges.json")));

  rmSync(customOut, { recursive: true, force: true });
});

test("--json stdout is exactly one parseable document; logs never on stdout", async () => {
  const f = fixture("split-statement");
  const testOut = mkdtempSync(join(tmpdir(), "c2s-json-contract-"));

  const res = await runCli([
    "extract",
    fpath(f),
    "--min-ms",
    "300",
    "--json",
    "--out",
    testOut,
  ]);

  assert.equal(res.code, 0);

  // stdout is exactly one line of JSON
  const lines = res.stdout.trim().split("\n");
  assert.equal(lines.length, 1, "stdout must contain exactly one line");

  const json = JSON.parse(lines[0]);
  assert.equal(json.version, 1);
  assert.ok(Array.isArray(json.sources));
  assert.equal(json.sources.length, 1);

  const source = json.sources[0];
  assert.equal(source.path, fpath(f));
  assert.equal(source.status, "ok");
  assert.deepEqual(source.errors, []);
  assert.ok(Array.isArray(source.statements));
  assert.equal(source.statements.length, 1);

  const stmt = source.statements[0];
  assert.equal(stmt.id, "s01");
  assert.equal(typeof stmt.startMs, "number");
  assert.equal(typeof stmt.endMs, "number");
  assert.equal(typeof stmt.peakProb, "number");
  assert.equal(typeof stmt.detection.startMs, "number");
  assert.equal(typeof stmt.detection.endMs, "number");
  assert.equal(typeof stmt.detection.peakProb, "number");
  assert.ok(stmt.candidates);
  assert.equal(stmt.clip, null);
  assert.equal(stmt.transcript, null);
  assert.equal(stmt.edited, false);

  assert.deepEqual(json.summary, {
    files: 1,
    statements: 1,
    clips: 0,
    failures: 0,
  });

  rmSync(testOut, { recursive: true, force: true });
});

test("--dry-run --json returns clip: null and renders nothing", async () => {
  const f = fixture("split-statement");
  const dryOutDir = join(tmpdir(), `c2s-dry-dir-${Date.now()}`);

  const res = await runCli([
    "extract",
    fpath(f),
    "--dry-run",
    "--json",
    "--min-ms",
    "300",
    "--out",
    dryOutDir,
  ]);

  assert.equal(res.code, 0);

  // Output directory must NOT be created in dry-run
  assert.equal(existsSync(dryOutDir), false, "dry-run must write nothing to disk");

  // Logs on stderr
  assert.ok(res.stderr.includes("dry-run"));

  // Exactly one JSON document on stdout
  const json = JSON.parse(res.stdout.trim());
  assert.equal(json.version, 1);
  assert.equal(json.summary.clip, null);
  assert.equal(json.summary.clips, 0);
  assert.equal(json.summary.files, 1);
  assert.equal(json.summary.statements, 1);
  assert.equal(json.summary.failures, 0);

  assert.equal(json.sources.length, 1);
  assert.equal(json.sources[0].statements[0].clip, null);
});

test("directory run reports one entry per Source; failures don't abort the batch", async () => {
  const batchDir = mkdtempSync(join(tmpdir(), "c2s-batch-"));
  const batchOut = mkdtempSync(join(tmpdir(), "c2s-batch-out-"));

  // Create two audio fixtures and one corrupt file
  const f1 = fixture("micro-statement");
  const f2 = fixture("split-statement");
  copyFileSync(fpath(f1), join(batchDir, "01-micro.wav"));
  writeFileSync(join(batchDir, "02-corrupt.wav"), "NOT AUDIO CONTENT AT ALL");
  copyFileSync(fpath(f2), join(batchDir, "03-split.wav"));

  const res = await runCli([
    "extract",
    batchDir,
    "--json",
    "--min-ms",
    "300",
    "--out",
    batchOut,
  ]);

  // Non-zero exit code because one source failed
  assert.equal(res.code, 1);

  // Exactly one parseable document on stdout
  const json = JSON.parse(res.stdout.trim());
  assert.equal(json.version, 1);
  assert.equal(json.summary.files, 3);
  assert.equal(json.summary.failures, 1);
  assert.equal(json.summary.statements, 2);

  // Directory run reports one entry per Source
  assert.equal(json.sources.length, 3);

  const [s1, s2, s3] = json.sources;
  assert.equal(s1.status, "ok");
  assert.equal(s1.statements.length, 1);

  assert.equal(s2.status, "error");
  assert.ok(s2.error.includes("ffmpeg failed"));
  assert.equal(s2.statements.length, 0);

  assert.equal(s3.status, "ok");
  assert.equal(s3.statements.length, 1);

  // Stderr captured failure
  assert.ok(res.stderr.includes("FAIL"));

  rmSync(batchDir, { recursive: true, force: true });
  rmSync(batchOut, { recursive: true, force: true });
});

test("directory run on empty directory returns empty sources and exit 0", async () => {
  const emptyDir = mkdtempSync(join(tmpdir(), "c2s-empty-"));
  const res = await runCli(["extract", emptyDir, "--dry-run", "--json"]);

  assert.equal(res.code, 0);
  const json = JSON.parse(res.stdout.trim());
  assert.equal(json.version, 1);
  assert.deepEqual(json.sources, []);
  assert.equal(json.summary.files, 0);
  assert.equal(json.summary.statements, 0);
  assert.equal(json.summary.failures, 0);
  assert.equal(json.summary.clip, null);

  rmSync(emptyDir, { recursive: true, force: true });
});
