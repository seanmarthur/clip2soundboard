import { parseArgs } from "node:util";
import { detectStatements, assertModelPinned } from "./detect.ts";
import { deriveRanges, loadSidecar, slugFromPath, type SidecarV1, type SidecarStatement } from "./sidecar.ts";
import { resolve } from "node:path";
import { readdirSync, statSync } from "node:fs";

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

function logJson(obj: unknown) {
  console.log(JSON.stringify(obj));
}

function logStderr(msg: string) {
  console.error(msg);
}

async function runExtract(inputPath: string, opts: CliOptions): Promise<{ version: 1; sources: SourceResult[]; summary: Summary }> {
  const { readdirSync, statSync } = await import("node:fs");
  const { resolve } = await import("node:path");

  const input = resolve(inputPath);
  const stat = statSync(input);
  const files = stat.isDirectory()
    ? readdirSync(input).filter((f) => /\.(mp4|mkv|webm|mov)$/i.test(f)).map((f) => resolve(input, f))
    : [input];

  const sources: SourceResult[] = [];
  let hasError = false;
  const summary = { files: 0, statements: 0, clips: 0, failures: 0 };

  for (const file of files) {
    summary.files++;
    const slug = slugFromPath(file);
    const sourceResult: SourceResult = {
      file,
      slug,
      statements: 0,
      clips: [],
      error: null,
    };

    try {
      if (!opts.dryRun) {
        logStderr(`${file}: deriving ranges...`);
        const sidecar = await deriveRanges(file, opts.out, {
          force: opts.force,
          rescan: opts.rescan,
          rescanHard: opts.rescanHard,
          minMs: opts.minMs,
          maxMs: opts.maxMs,
          fuzz: opts.fuzz,
        });
        logStderr(`${file}: ${sidecar.statements.length} statements`);
        sourceResult.statements = sidecar.statements.length;
        summary.statements += sidecar.statements.length;

        for (const stmt of sidecar.statements) {
          if (stmt.clip) {
            sourceResult.clips.push({
              id: stmt.id,
              path: stmt.clip.path,
              bytes: stmt.clip.bytes,
              renderedFrom: stmt.clip.renderedFrom,
              startMs: stmt.startMs,
              endMs: stmt.endMs,
            });
            summary.clips++;
          }
        }
      } else {
        const st = await detectStatements(file);
        const filtered = st.filter((s) => s.endMs - s.startMs >= opts.minMs && s.endMs - s.startMs <= opts.maxMs);
        sourceResult.statements = filtered.length;
        summary.statements += filtered.length;
        logStderr(`${file}: ${filtered.length} statements (dry-run)`);
      }
    } catch (e) {
      const errMsg = String(e).slice(0, 500);
      sourceResult.error = errMsg;
      summary.failures++;
      hasError = true;
      logStderr(`FAIL ${file}: ${errMsg}`);
    }

    sources.push(sourceResult);
  }

  return {
    version: 1,
    sources,
    summary,
  };
}

interface SourceResult {
  file: string;
  slug: string;
  statements: number;
  clips: ClipResult[];
  error: string | null;
}

interface ClipResult {
  id: string;
  path: string;
  bytes: number;
  renderedFrom: string;
  startMs: number;
  endMs: number;
}

interface Summary {
  files: number;
  statements: number;
  clips: number;
  failures: number;
}

async function main() {
  const args = parseArgs({
    args: process.argv.slice(2),
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
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });

  if (args.values.help || args.positionals.length === 0) {
    console.error(`Usage: clip2soundboard extract <file|dir> [options]

Options:
  -o, --out <dir>         Output directory (default: ./clips)
  --fuzz <seconds>        Fuzziness window in seconds (default: 0)
  --min-ms <ms>           Minimum statement length (default: 1000)
  --max-ms <ms>           Maximum statement length (default: 30000)
  --force                 Override edited ranges
  --rescan                Re-detect, keep human-edited ranges
  --rescan-hard           Re-detect, discard all edits
  --json                  Machine-readable output
  --dry-run               Detect only, write nothing
  --no-transcript         Skip transcript (default: true)
  -h, --help              Show this help
`);
    process.exit(args.values.help ? 0 : 1);
  }

  const subcommand = args.positionals[0];
  if (subcommand !== "extract") {
    console.error(`Unknown subcommand: ${subcommand}`);
    console.error("Available: extract");
    process.exit(1);
  }

  const input = args.positionals[1];
  if (!input) {
    console.error("Missing input file or directory");
    process.exit(1);
  }

  await assertModelPinned();

  const opts: CliOptions = {
    out: resolve(args.values.out),
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

  const result = await runExtract(input, opts);

  if (opts.json) {
    logJson(result);
  }

  process.exit(result.summary.failures > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`Fatal: ${err}`);
  process.exit(1);
});