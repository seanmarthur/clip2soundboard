# Silero VAD in Node — engine, ONNX runtime, tuning defaults

Resolution artifact for issue #2. Measured in the `work/fixture-designer`
worktree; companion spike lives inside `research/verification-strategy.md`
(same branch). No docs-trust: every claim here was run on this machine.

## Engine choice

- **`@ricky0123/vad-node@0.0.3`**, pulling `onnxruntime-node@1.30.0`
  transitively. Installed and passed on first attempt.
- **Drive `onnxruntime-node` `InferenceSession` directly, not the package's
  `NonRealTimeVAD` wrapper**: the wrapper reports segment ends padded by
  `redemptionFrames` (it closes at the redemption window, not at the audio
  offset) — wrong for boundary recovery. The session takes the vendored `.onnx`
  directly and returns per-frame `isSpeech` probabilities.

## Model sourcing and license

- `@ricky0123/vad-node` **vendors** `silero_vad.onnx` in its own `dist/`
  (1,807,522 bytes, sha256
  `a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28`).
  No download at install or runtime — read from disk by the package's model
  fetcher. Model license MIT (snakers4/silero-vad v4/v5 card); package ISC.
- Consequence: the VAD leg is offline after `npm ci`; CI carries no model
  download. Assert the sha256 before any detection run (see #11 artifacts).

## Install caveat (load-bearing)

Both `onnxruntime-node` (postinstall) and `ffmpeg-static` (install.js) are
install-script packages. A hardened npm config (`npm_config_block_postinstall`)
blocks them silently, leaving a half-installed onnxruntime that fails at first
`require`, not at install. Fix: `npm approve-scripts onnxruntime-node
ffmpeg-static` then `npm rebuild`. Document in the README.

## Input format and frames

- 16 kHz mono float32, **512-sample (32 ms) frames**.
- Measured probabilities: silence 0.00–0.10, voice-like bursts 0.70–0.99.

## Measured behavior in our domain

1. **LSTM state decays ~130–190 ms after a hard audio offset**: probabilities
   stay ≥0.35 for 4–6 frames past the real end, so raw threshold crossings
   overshoot Statement ends by up to ~190 ms. Consequence (matches ADR-0001):
   VAD is the *coarse* segmenter; exact edges are recovered in the sample
   domain via a short-window energy envelope vs the noise floor. A Range
   derivation trusting VAD frame crossings alone cannot meet ±60 ms and must
   not be written.
2. **Pure sine tones are out-of-distribution** (~0.40–0.65 wobbling `isSpeech`
   inside one burst) — useless as fixtures. Working synthetic voice: 16-harmonic
   stack (f0 = 120 Hz, 1/n² rolloff), 4 Hz syllabic envelope, ±0.01 broadband
   dither; without the dither the periodic stack still wobbles.
3. **Noise below the voice band is a free case**: pink noise low-passed to
   300 Hz keeps silero at ~0.00 `isSpeech`; neither triggers nor shifts.

## Not verified here

- `silero-vad-node`, `node-vad` alternatives: not tried — `@ricky0123/vad-node`
  worked first try and the alternatives carry no model vendoring story.
- Streaming/whole-buffer trade-offs beyond the 32 ms frame contract: the
  pipeline decodes to a stream and re-frames chunks itself (pipes never deliver
  frame-aligned chunks — measured on the ffmpeg leg, see #4 artifacts).
- Threshold tuning beyond the measured 0.70/0.10 separation; real VOD audio
  goes through the Fuzziness re-run regardless.
