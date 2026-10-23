# Verification strategy: synthetic fixtures for a fuzzy domain

Part of issue #11. This records only what was measured in the `work/fixture-designer`
worktree; the broader VAD-vs-whisper docs research lives in ticket #2 and ADR-0001.

## VAD spike (de-risks ticket #2)

Question: can a Node silero VAD install and run at all?

- **Package that worked**: `@ricky0123/vad-node@0.0.3`, pulling
  `onnxruntime-node@1.30.0` transitively. `silero-vad-node` was not tried —
  `@ricky0123/vad-node` installed and passed on the first attempt.
- **Install caveat**: both `onnxruntime-node` (postinstall) and `ffmpeg-static`
  (install.js) are install-script packages. A hardened npm setup
  (`npm_config_block_postinstall`) blocks them; they need an explicit allow-list
  (`npm approve-scripts onnxruntime-node ffmpeg-static`, then `npm rebuild`).
  Document this in the eventual README — a silent block leaves a half-installed
  onnxruntime that fails at first `require`, not at install.
- **Model file**: `@ricky0123/vad-node` **vendors** `silero_vad.onnx` inside its
  own `dist/` (1,807,522 bytes, sha256
  `a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28`). No
  download at install or at runtime — it is read from disk by the package's own
  model fetcher. Model license: MIT, from `snakers4/silero-vad` (v4/v5 model
  card). Package license: ISC. This means the CI leg needs no model download.
- **ffmpeg**: `ffmpeg-static@5.3.0` works and provides every filter the fixture
  generator uses (`aevalsrc`/`sine`/`anoisesrc`/`anullsrc`, `amix`, `lowpass`).
- **Does a 16 kHz mono float32 buffer yield frame probabilities?** Yes. The
  package's `NonRealTimeVAD.run()` yields speech segments; more use for us, the
  underlying `onnxruntime-node` `InferenceSession` takes the vendored `.onnx`
  directly and returns a per-frame `isSpeech` probability at 512-sample (32 ms)
  frames: silence measured 0.00–0.10, voice-like bursts 0.70–0.99. We drive the
  session directly (see `scripts/fixtures-check.mjs`) rather than through
  `NonRealTimeVAD`, because the wrapper's reported segment ends are padded by
  `redemptionFrames` (it reports where the redemption window *closes*, not where
  the audio stopped) — wrong for boundary recovery.

## Fixture inventory (`node scripts/fixtures-check.mjs` regenerates and checks)

`scripts/fixtures-gen.mjs` emits deterministic 16 kHz mono PCM16 WAV Sources via
ffmpeg-static and writes per-boundary ground truth to
`scripts/fixtures/ground-truth.json`. Four Sources:

| Fixture           | Ground truth                              | Tests                                            |
| ----------------- | ----------------------------------------- | ------------------------------------------------ |
| `micro-statement` | one Statement 500–800 ms                  | 0.3 s micro-Statement survives `minSpeechFrames`  |
| `split-statement` | one Statement 500–1500 ms (200 ms pause)  | Fuzziness bridges a 200 ms internal pause        |
| `noise-floor`     | one Statement 400–1000 ms                 | sub-voice-band noise (pink, low-passed 300 Hz) does not move or spawn Ranges |
| `silence-only`    | no Statements                             | background noise alone yields nothing            |

Current check result: **all pass**, Statement boundaries land on ground truth
(Δ = 0 ms on every edge) and detection is bit-identical across repeated runs.

## What the fixtures taught the design (measured, not assumed)

1. **Pure sine tones are out-of-distribution for silero.** A 220 Hz sine burst
   scored a marginal ~0.40–0.65 `isSpeech`, oscillating inside a single burst —
   useless for a stable threshold. The working synthetic voice is a 16-harmonic
   stack (f0 = 120 Hz, 1/n² rolloff) with a 4 Hz syllabic envelope plus a light
   (±0.01) broadband dither; without the dither the stack is perfectly periodic
   and silero still wobbles. Fixtures are therefore harmonic-stacked, not sine.
2. **Silero's LSTM state decays slowly (~130–190 ms) after a hard offset.**
   Probabilities stay ≥0.35 for ~4–6 frames after the audio actually stops, so
   raw threshold crossings *overshoot the end* of a Statement by up to ~190 ms.
   This is exactly the "silence valleys" ADR-0001 says the detection pass should
   store. Consequence for the pipeline: **VAD is the coarse segmenter; exact
   edges are recovered in the sample domain** (short-window energy envelope with
   a noise-floor-relative threshold). The check implements this and the edges
   then land exactly. A Range-derivation step that trusts VAD frame crossings
   alone cannot meet a ±60 ms bound and should not be written.
3. **Noise below the voice band is a free case.** Pink noise low-passed to
   300 Hz keeps silero at ~0.00 `isSpeech`; it neither triggers nor shifts
   detection.

## Invariants the pipeline must assert (fixtures are where they get tested)

- **Detection determinism at fixed settings**: same Source, same model, same
  thresholds → identical Ranges. Enforced twice per fixture in the check.
- **Ranges stable across re-runs at fixed Fuzziness**: re-running a Source with
  an unchanged Fuzziness reproduces identical Ranges. (Checked via
  determinism; the check is the prototype for the real Range derivation.)
- **Hand-edit preservation**: a hand-adjusted Range must survive a re-run — the
  re-run may *propose* growth through Fuzziness but must never silently
  overwrite a human-touched Range. Fixture: edit a stored Range, re-run at fixed
  Fuzziness, assert the stored value is unchanged until accepted.
- **Clip render byte-length sanity**: the rendered Clip's duration (from its WAV
  header) must equal its Range's length within one encoder frame (~±10 ms), and
  its peak must clear a silence floor. Catches offset drift between detection
  and render. Not yet implemented — belongs to the render ticket; noted here as
  the boundary this fixture set already makes testable.

## How detection stays deterministic

- **Pinned model**: the vendored `silero_vad.onnx` sha256 is asserted before any
  detection runs; a model swap fails the check loudly.
- **Pinned packages**: `package-lock.json` commits exact versions of
  `@ricky0123/vad-node` and `onnxruntime-node`.
- **Deterministic fixtures**: seeded PRNG (`mulberry32`), no wall-clock, no
  unseeded randomness; ffmpeg `lavfi` sources are deterministic for fixed
  arguments.
- **Threads**: onnxruntime-node on CPU produced bit-identical probabilities
  across repeated full runs on this machine, so no thread pinning was needed. If
  a future platform diverges, the upgrade path is a pinned
  `InferenceSession` option `intraOpNumThreads: 1` — unmeasured, add only when a
  divergence is actually observed.

## CI vs local

- **Runs in CI (offline after `npm ci`)**: the whole fixture generator + VAD
  check. The only network needed is the npm registry itself (plus
  `ffmpeg-static`'s one-time binary fetch inside its install script — same as
  any other dependency install). No model download at test time.
- **Stays local / skipped in CI**: anything that needs a **whisper model
  download**. The Transcript is a judgement aid, never boundary logic
  (ADR-0001), so skipping it in CI costs no coverage of the Range/Clip
  invariants above. Gate whisper-dependent tests behind an explicit opt-in
  (e.g. an env flag run locally or on a scheduled job), not a silent skip.
  Whisper's own install/availability is ticket #2's scope; this is only the
  boundary of what CI must carry.

## Known ceiling

- The synthetic voice approximates *voiced* speech; it has no fricatives or
  unvoiced onsets, which are the hard boundary case in real VODs. If that bite
  shows up, add one TTS-sourced fixture rather than growing the harmonic model.
- The energy-refinement thresholds (2.5× noise floor, 0.15× peak, 20 ms run at
  Statement end) are measured-good on these four Sources, not tuned. Real VOD
  audio goes through the Fuzziness re-run regardless.
