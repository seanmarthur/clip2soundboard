# clip2soundboard

Extract audio clips from video files with speech detection, fuzziness adjustment, and loudness-normalized MP3 rendering.

## CLI — Agent Surface

```
clip2soundboard extract <file|dir> [options]
```

### Options

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `-o, --out <dir>` | string | `./clips` | Output directory for sidecars and clips |
| `--fuzz <seconds>` | number | `0` | Fuzziness window in seconds for edge snapping |
| `--min-ms <ms>` | number | `1000` | Minimum statement length in milliseconds |
| `--max-ms <ms>` | number | `30000` | Maximum statement length in milliseconds |
| `--force` | boolean | `false` | Override human-edited ranges |
| `--rescan` | boolean | `false` | Re-detect, keep human-edited ranges |
| `--rescan-hard` | boolean | `false` | Re-detect, discard all edits |
| `--json` | boolean | `false` | Machine-readable output (single JSON document on stdout) |
| `--dry-run` | boolean | `false` | Detect only, write nothing |
| `--no-transcript` | boolean | `true` | Skip transcript generation |
| `-h, --help` | boolean | | Show help |

### Exit Codes

- `0` — all files succeeded
- `1` — any file failed (or usage error)

### `--json` Output Contract

When `--json` is specified, exactly **one** JSON document is printed to stdout. All logs, progress, and errors go to stderr.

**Shape:**

```json
{
  "version": 1,
  "sources": [
    {
      "file": "/absolute/path/to/input.mp4",
      "slug": "input",
      "statements": 3,
      "clips": [
        {
          "id": "s01",
          "path": "./clips/input-s01.mp3",
          "bytes": 123456,
          "renderedFrom": "bounds-hash",
          "startMs": 1000,
          "endMs": 3000
        }
      ],
      "error": null
    }
  ],
  "summary": {
    "files": 1,
    "statements": 3,
    "clips": 0,
    "failures": 0
  }
}
```

**`--dry-run --json`** returns the same shape with `clips: []` (always empty) and renders nothing.

**Rules:**
- stdout is exactly one parseable JSON document — no extra lines, no logs
- stderr carries per-file progress, errors, and diagnostics
- directory traversal is sequential; failures don't abort the batch
- `clip` is `null` in dry-run mode
- transcript field omitted/empty when `--no-transcript` (default)

## Development

```bash
npm test       # run all tests (node:test)
npm run typecheck  # tsc --noEmit
```

## License

MIT