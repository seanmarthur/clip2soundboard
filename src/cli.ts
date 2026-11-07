#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readdirSync, statSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { detectStatements, assertModelPinned } from "./detect.ts";
import { deriveRanges, loadSidecar, slugFromPath } from "./sidecar.ts";

interface CliOptions {
  out: string;
  fuzz: number;
  minMs: number;
  maxMs: number;
  force: boolean;
  rescan: boolean;
  rescanHard: boolean;
  json: boolean;
  dryRun: boolean;
  noTranscript: boolean;
}

const DEFAULTS: CliOptions = {
  out: "./clips",
  fuzz: 0,
  minMs: 1000,
  maxMs: 30000,
  force: false,
  rescan: false,
  rescanHard: false,
  json: false,
  dryRun: false,
  noTranscript: true,
};

async function main() {
  const rawArgs = process.argv.slice(2);

  if (rawArgs.length === 0 || rawArgs[0] === "help" || rawArgs[0] === "-h" || rawArgs[0] === "--help") {
    showHelp();
    process.exit(rawArgs.length === 0 ? 1 : 0);
  }

  const subcommand = rawArgs[0];
  if (!["extract", "render"].includes(subcommand)) {
    console.error(`Unknown subcommand: ${subcommand}`);
    console.error("Available: extract, render");
    process.exit(1);
  }

  const args = parseArgs({
    args: rawArgs.slice(1),
    options: {
      out: { type: "string", short: "o", default: DEFAULTS.out },
      fuzz: { type: "string", default: String(DEFAULTS.fuzz) },
      "min-ms": { type: "string", default: String(DEFAULTS.minMs) },
      "max-ms": { type: "string", default: String(DEFAULTS.maxMs) },
      force: { type: "boolean", default: DEFAULTS.force },
      rescan: { type: "boolean", default: DEFAULTS.rescan },
      "rescan-hard": { type: "boolean", default: DEFAULTS.rescanHard },
      json: { type: "boolean", default: DEFAULTS.json },
      "dry-run": { type: "boolean", default: DEFAULTS.dryRun },
      "no-transcript": { type: "boolean", default: DEFAULTS.noTranscript },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });

  if (args.values.help || args.positionals.length === 0) {
    showHelp();
    process.exit(args.values.help ? 0 : 1);
  }

  await assertModelPinned();

  const input = args.positionals[0];
  const inputPath = resolve(input);
  const outDir = resolve(args.values.out ?? DEFAULTS.out);
  const opts = {
    outDir,
    fuzz: Number(args.values.fuzz ?? DEFAULTS.fuzz),
    minMs: Number(args.values["min-ms"] ?? DEFAULTS.minMs),
    maxMs: Number(args.values["max-ms"] ?? DEFAULTS.maxMs),
    force: args.values.force ?? DEFAULTS.force,
    rescan: args.values.rescan ?? DEFAULTS.rescan,
    rescanHard: args.values["rescan-hard"] ?? DEFAULTS.rescanHard,
    json: args.values.json ?? DEFAULTS.json,
    dryRun: args.values["dry-run"] ?? DEFAULTS.dryRun,
    noTranscript: args.values["no-transcript"] ?? DEFAULTS.noTranscript,
  };

  let hasError = false;
  const summary: any = {
    version: 1,
    sources: [],
    summary: {
      files: 0,
      statements: 0,
      clips: 0,
      failures: 0,
      ...(opts.dryRun ? { clip: null } : {}),
    },
  };

  if (!existsSync(inputPath)) {
    console.error(`Input path does not exist: ${input}`);
    summary.summary.files++;
    summary.summary.failures++;
    summary.sources.push({
      path: inputPath,
      status: "error",
      error: `Input path does not exist: ${input}`,
      errors: [`Input path does not exist: ${input}`],
      statements: [],
    });
    if (opts.json) {
      console.log(JSON.stringify(summary));
    }
    process.exit(1);
  }

  const stat = statSync(inputPath);
  const files = stat.isDirectory()
    ? readdirSync(inputPath)
        .filter((f) => /\.(mp4|mkv|webm|mov|wav)$/i.test(f))
        .map((f) => resolve(inputPath, f))
        .sort()
    : [inputPath];

  for (const file of files) {
    summary.summary.files++;
    try {
      const slug = slugFromPath(file);
      const sidecarPath = join(outDir, `${slug}.ranges.json`);

      if (opts.dryRun) {
        const st = await detectStatements(file);
        const filtered = st.filter(
          (s) => s.endMs - s.startMs >= opts.minMs && s.endMs - s.startMs <= opts.maxMs
        );
        console.error(`${file}: ${filtered.length} statements (dry-run)`);

        let nextId = 1;
        const statements = filtered.map((s) => ({
          id: `s${String(nextId++).padStart(2, "0")}`,
          startMs: s.startMs,
          endMs: s.endMs,
          peakProb: s.peakProb,
          detection: {
            startMs: s.detection.startMs,
            endMs: s.detection.endMs,
            peakProb: s.peakProb,
          },
          candidates: s.candidates,
          clip: null,
          transcript: null,
          edited: false,
          note: null,
        }));

        summary.sources.push({
          path: file,
          status: "ok",
          errors: [],
          statements,
        });
        summary.summary.statements += statements.length;
      } else {
        const sidecar = await deriveRanges(file, outDir, {
          force: opts.force,
          rescan: opts.rescan,
          rescanHard: opts.rescanHard,
          minMs: opts.minMs,
          maxMs: opts.maxMs,
          fuzz: opts.fuzz,
        });

        if (subcommand === "render") {
          const sidecarMod = (await import("./sidecar.ts")) as any;
          if (typeof sidecarMod.renderSidecar === "function") {
            await sidecarMod.renderSidecar(sidecarPath, file, outDir, {});
          } else {
            throw new Error("Render subcommand not supported in this version");
          }
        }

        const finalSidecar =
          subcommand === "render"
            ? (loadSidecar(sidecarPath) ?? sidecar)
            : sidecar;

        summary.sources.push({
          path: file,
          status: "ok",
          errors: [],
          statements: finalSidecar.statements.map((s) => ({
            id: s.id,
            startMs: s.startMs,
            endMs: s.endMs,
            peakProb: s.detection?.peakProb,
            detection: s.detection,
            candidates: s.candidates,
            clip: s.clip,
            transcript: s.transcript,
            edited: s.edited,
            note: s.note,
          })),
        });
        summary.summary.statements += finalSidecar.statements.length;
        summary.summary.clips += finalSidecar.statements.filter((s) => s.clip).length;
      }
    } catch (e: any) {
      summary.summary.failures++;
      hasError = true;
      const errMsg = String(e?.message || e).slice(0, 200);
      console.error(`FAIL ${file}: ${errMsg}`);
      summary.sources.push({
        path: file,
        status: "error",
        error: errMsg,
        errors: [errMsg],
        statements: [],
      });
    }
  }

  if (opts.json) {
    console.log(JSON.stringify(summary));
  }

  process.exit(hasError ? 1 : 0);
}

function showHelp() {
  console.error(`Usage: clip2soundboard <command> <file|dir> [options]

Commands:
  extract  Detect statements and write sidecar (no render)
  render   Extract + apply fuzz + render clips to mp3

Options:
  -o, --out <dir>         Output directory (default: ./clips)
  --fuzz <seconds>        Fuzziness window in seconds (default: 0)
  --min-ms <ms>           Minimum statement length (default: 1000)
  --max-ms <ms>           Maximum statement length (default: 30000)
  --force                 Override edited ranges
  --rescan                Re-detect, keep human-edited ranges
  --rescan-hard           Re-detect, discard all edits
  --json                  Machine-readable output
  --dry-run               Detect only, write nothing (extract only)
  --no-transcript         Skip transcript (default: true)
  -h, --help              Show this help
`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
