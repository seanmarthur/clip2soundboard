import { parseArgs } from "node:util";
import { detectStatements, assertModelPinned } from "./detect.ts";
import { deriveRanges, loadSidecar, SidecarV1 } from "./sidecar.ts";
import { slugFromPath } from "./sidecar.ts";

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
  const summary: any = { files: 0, statements: 0, clips: 0, failures: 0 };

  for (const file of files) {
    summary.files++;
    try {
      if (!args.values["dry-run"]) {
        await deriveRanges(file, outDir, opts);
      } else {
        const st = await detectStatements(file);
        const filtered = st.filter((s) => s.endMs - s.startMs >= opts.minMs && s.endMs - s.startMs <= opts.maxMs);
        console.error(`${file}: ${filtered.length} statements (dry-run)`);
      }
      summary.statements += 1; // simplified
    } catch (e) {
      summary.failures++;
      hasError = true;
      console.error(`FAIL ${file}: ${String(e).slice(0, 200)}`);
    }
  }

  if (args.values.json) {
    console.log(JSON.stringify({ version: 1, sources: [], summary }));
  }

  process.exit(hasError ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
