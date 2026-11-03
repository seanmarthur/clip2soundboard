import { parseArgs } from "node:util";
import { detectStatements, assertModelPinned } from "./detect.ts";
import { deriveRanges, loadSidecar, slugFromPath, renderSidecar } from "./sidecar.ts";

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
  
  let subcommand = rawArgs[0];
  if (!["extract", "render"].includes(subcommand)) {
    console.error(`Unknown subcommand: ${subcommand}`);
    console.error("Available: extract, render");
    process.exit(1);
  }
  
  const args = parseArgs({
    args: rawArgs.slice(1),
    options: {
      out: { type: "string", short: "o", default: "./clips" },
      fuzz: { type: "string", default: "0" },
      "min-ms": { type: "string", default: "1000" },
      "max-ms": { type: "string", default: "30000" },
      force: { type: "boolean", default: false },
      rescan: { type: "boolean", default: false },
      "rescan-hard": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      "no-transcript": { type: "boolean", default: true },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });

  if (args.values.help || args.positionals.length === 0) {
    showHelp();
    process.exit(args.values.help ? 0 : 1);
  }

  await assertModelPinned();

  const input = args.positionals[0];
  const { readdirSync, statSync } = await import("node:fs");
  const { resolve } = await import("node:path");

  const inputPath = resolve(input);
  const stat = statSync(inputPath);
  const files = stat.isDirectory()
    ? readdirSync(inputPath).filter((f) => /\.(mp4|mkv|webm|mov)$/i.test(f)).map((f) => resolve(inputPath, f))
    : [inputPath];

  const outDir = resolve(args.values.out);
  const opts = {
    outDir,
    fuzz: Number(args.values.fuzz),
    minMs: Number(args.values["min-ms"]),
    maxMs: Number(args.values["max-ms"]),
    force: args.values.force,
    rescan: args.values.rescan,
    rescanHard: args.values["rescan-hard"],
    json: args.values.json,
    dryRun: args.values["dry-run"],
    noTranscript: args.values["no-transcript"],
  };

  let hasError = false;
  const summary: any = { version: 1, sources: [], summary: { files: 0, statements: 0, clips: 0, failures: 0 } };

  for (const file of files) {
    summary.summary.files++;
    try {
      const slug = file.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") ?? "source";
      const sidecarPath = `${outDir}/${slug}.ranges.json`;

      if (subcommand === "extract" || subcommand === "render") {
        // First derive ranges (with fuzz applied)
        const sidecar = await deriveRanges(file, outDir, {
          force: args.values.force,
          rescan: args.values.rescan,
          rescanHard: args.values["rescan-hard"],
          minMs: Number(args.values["min-ms"]),
          maxMs: Number(args.values["max-ms"]),
          fuzz: Number(args.values.fuzz),
        });

        if (subcommand === "extract" && opts.dryRun) {
          const st = await import("./detect.ts").then((m) => m.detectStatements(file));
          const filtered = st.filter((s) => s.endMs - s.startMs >= opts.minMs && s.endMs - s.startMs <= opts.maxMs);
          console.error(`${file}: ${filtered.length} statements (dry-run)`);
        }

        if (subcommand === "render") {
          // Render clips for this source
          await import("./sidecar.ts").then((m) => m.renderSidecar(
            `${outDir}/${slug}.ranges.json`,
            file,
            outDir,
            {}
          ));
        }

        // Load sidecar for summary
        const { loadSidecar } = await import("./sidecar.ts");
        const finalSidecar = loadSidecar(`${outDir}/${slug}.ranges.json`);
        
        summary.sources.push({
          path: file,
          status: "ok",
          statements: finalSidecar?.statements.map((s) => ({
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
          })) || [],
        });
        summary.summary.statements += finalSidecar?.statements.length || 0;
        summary.summary.clips += finalSidecar?.statements.filter((s) => s.clip).length || 0;
      }
    } catch (e) {
      summary.summary.failures++;
      hasError = true;
      console.error(`FAIL ${file}: ${String(e).slice(0, 200)}`);
      summary.sources.push({ path: file, status: "error", error: String(e).slice(0, 200) });
    }
  }

  if (args.values.json) {
    console.log(JSON.stringify({ version: 1, ...summary }));
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

const opts: any = {}; // placeholder for summary reference
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
