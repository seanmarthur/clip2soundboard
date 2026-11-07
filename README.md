# clip2soundboard

CLI that takes local video clips and extracts replayable human-voice statements as soundboard-ready audio.

## Usage

```bash
clip2soundboard <command> <file|dir> [options]
```

Or invoke directly with Node:

```bash
node src/cli.ts <command> <file|dir> [options]
```

### Commands

- `extract <file|dir>`: Detect voice statements and persist range sidecars (`<source-slug>.ranges.json`) without rendering audio clips.
- `render <file|dir>`: Extract statements, apply fuzziness snap, and render audio clips as soundboard-ready MP3s.

### Flags & Options

| Flag | Short | Default | Description |
| --- | --- | --- | --- |
| `--out <dir>` | `-o` | `./clips` | Output directory for ranges sidecars and audio clips |
| `--fuzz <seconds>` | | `0` | Fuzziness window in seconds (snaps statement edges to nearest valley candidates) |
| `--min-ms <ms>` | | `1000` | Minimum statement length in milliseconds; statements shorter than this are skipped |
| `--max-ms <ms>` | | `30000` | Maximum statement length in milliseconds |
| `--force` | | `false` | Override protection for human-edited statement ranges |
| `--rescan` | | `false` | Re-run detection while preserving human-edited ranges |
| `--rescan-hard` | | `false` | Re-run detection, discarding all existing edits and notes |
| `--json` | | `false` | Emit machine-readable JSON document on stdout |
| `--dry-run` | | `false` | Detect only; write no sidecars and render no clips |
| `--no-transcript` | | `true` | Skip transcript generation |
| `--help` | `-h` | | Show usage help |

---

## Agent-Facing Contract (`--json`)

When `--json` is passed, `clip2soundboard` adheres to a strict contract designed for automated agent control.

### Stream Separation

- **stdout**: Contains **exactly one** parseable JSON document printed upon run completion. No informational logs, progress messages, or warnings are ever emitted to stdout.
- **stderr**: Receives all human-readable logs, ffmpeg output, per-file progress updates, and error messages.

### Exit Codes

- `0`: All input files were processed successfully.
- `1`: One or more files failed, invalid command/subcommand was supplied, or an input path was missing. In a directory run, individual file failures do not abort the batch; remaining files continue to be processed.

### Contract Versioning

- `version`: Integer tracking the contract schema (currently `1`).
- Backward-compatible additions (e.g. new metadata fields) constitute minor changes.
- Renames or deletions of existing fields constitute a breaking major version bump.

### JSON Schema

The top-level JSON document has the following structure:

```json
{
  "version": 1,
  "sources": [
    {
      "path": "/path/to/source.mp4",
      "status": "ok",
      "errors": [],
      "statements": [
        {
          "id": "s01",
          "startMs": 520,
          "endMs": 1530,
          "peakProb": 0.9983,
          "detection": {
            "startMs": 512,
            "endMs": 1664,
            "peakProb": 0.9983
          },
          "candidates": {
            "onsetValleyMs": 420,
            "offsetValleyMs": 1750,
            "internalValleysMs": [690, 700, 930, 1000]
          },
          "clip": {
            "path": "/path/to/clips/s01_7ba0887e89e8.mp3",
            "bytes": 19532,
            "renderedFrom": "7ba0887e89e8"
          },
          "transcript": null,
          "edited": false,
          "note": null
        }
      ]
    }
  ],
  "summary": {
    "files": 1,
    "statements": 1,
    "clips": 1,
    "failures": 0
  }
}
```

#### Statement Fields

- `id`: Stable statement identifier (e.g., `s01`, `s02`), assigned at first detection and never reused.
- `startMs` / `endMs`: Statement boundary timestamps in milliseconds.
- `peakProb`: Maximum speech probability returned by Silero VAD for this utterance.
- `detection`: Original unadjusted detection boundaries and peak probability.
- `candidates`: Energy envelope valley candidates (`onsetValleyMs`, `offsetValleyMs`, `internalValleysMs`) used for fuzziness adjustments.
- `clip`: Audio clip metadata (`path`, `bytes`, `renderedFrom` bounds hash), or `null` if not rendered.
- `transcript`: Transcription record (`{ text, model, at }`), or `null` if omitted.
- `edited`: Boolean indicating whether boundaries were manually modified.
- `note`: Operational note or diagnostic proposal (e.g., proposed bounds on re-detection).

#### Source Error Format

If an individual Source in a batch fails to process (e.g., corrupted audio), its entry in `sources` reflects the failure without aborting the remaining files:

```json
{
  "path": "/path/to/corrupt.mp4",
  "status": "error",
  "error": "ffmpeg failed (...): Invalid data found when processing input",
  "errors": ["ffmpeg failed (...): Invalid data found when processing input"],
  "statements": []
}
```

#### Dry-Run Contract (`--dry-run --json`)

When invoked with `--dry-run`:
- No sidecar files (`.ranges.json`) are written to disk.
- No audio clips are rendered.
- The returned JSON document maintains the identical structure:
  - Statements report detected boundaries and candidate valleys.
  - Per-statement `clip` is `null`.
  - `summary.clips` is `0` (and `summary.clip` is `null`).
