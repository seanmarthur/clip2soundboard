# ffmpeg pipeline experiments — clip2soundboard v1

Empirical basis for #5 (pipeline shape) and #10 (Clip render spec). Every claim below carries the
exact command, the observed output, and the raw numbers.

## Environment

```
ffmpeg version 7.0.2-static (ffmpeg-static@5.3.0, node_modules/ffmpeg-static/ffmpeg)
ffprobe 7.0.2 (ffprobe-static)
Node v24.19.0
```

Synthetic Sources generated in `exp/` (commands in `exp/gen-sources.sh`):

| Source | Shape |
| ------ | ----- |
| `src_burst.mp4` | 4.5 s digital silence, known sine burst 0.3 s at t=1.000–1.300, 440 Hz, peak −13.7 dBFS |
| `src_stmt.mp4` | 10 s: 5 s statement (harmonic stack, 3 Hz syllable envelope) → 200 ms pause (5.000–5.200) → 3 s statement, white noise throughout (floor ≈ −36 dBFS) |
| `src_speech.mp4` | 10 s speech-like: fundamental sweep 170→220 Hz + harmonics ×3/×5/×7, 4.5 Hz syllable envelope |
| `src_onset.mp4` | 10 s, exact digital silence 0–3.000, speech-like 3.000–10 (onset-drift probe) |
| `ons_raw.wav` | speech-like burst 1.000–6.000 over white noise floor (−43.8 dBFS RMS) |

Measurement helpers used throughout:

```bash
# integrated loudness (ebur128 summary block)
measure() { ffmpeg -hide_banner -nostats -i "$1" -af ebur128=peak=true -f null - 2>&1 |
  sed -n '/Summary:/,$p' | grep -E "^\s+(I:|LRA:|Peak:)"; }
# overall RMS (astats "Overall" block)
rms()     { ffmpeg -hide_banner -nostats -i "$1" -af astats=measure_overall=RMS_level -f null - 2>&1 |
  awk '/\] Overall/{o=1} o&&/RMS level dB/{print $NF; exit}'; }
```

---

## 1. loudnorm single-pass on a 0.3 s Clip vs a 5 s Clip

Params under test: `I=-16 TP=-1.5 LRA=11`.

### 1a. Does it error/deny on very short input? — No. Not at 0.02 s either.

```bash
ffmpeg -hide_banner -i b_0.3.mp3 -af loudnorm=I=-16:TP=-1.5:LRA=11 -f null - -v warning
# exit 0, empty stderr — no warning, no denial, at 0.3 s, 0.05 s, 0.02 s
```

What it does instead: **silently misses the target.** Single-pass (dynamic mode), output measured
with ebur128:

| input clip | input I | output I | output TP | verdict |
| --- | --- | --- | --- | --- |
| `b_0.3.mp3` (0.3 s) | −70.0 LUFS (gate empty) | **−70.0 LUFS** | −1.5 dBFS | target missed; only TP limiter acted |
| `b_0.5.mp3` (0.5 s) | −20.3 LUFS | −16.0 LUFS | −9.4 dBFS | ok |
| `b_1.mp3` (1 s) | — | −16.0 LUFS | −8.4 dBFS | ok |
| `b_5.mp3` (5 s, sparse) | −21.2 LUFS | **−9.0 LUFS** | −1.5 dBFS | overshoots target by 7 LU |
| `clip_5s.mp3` (dense 5 s) | −23.7 LUFS | −16.0 LUFS | −4.8 dBFS | ok |
| `tiny02.wav` (0.02 s) | −70.0 LUFS | −70.0 LUFS | −1.5 dBFS | no error, no effect |

Root cause visible in the two-pass first pass on the 0.3 s Clip — the EBU gating block never fills,
so integrated loudness is **`-inf`**:

```
$ ffmpeg -hide_banner -nostats -i clip_burst.mp3 -af loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json -f null -
{
	"input_i" : "-inf",
	"input_tp" : "-13.67",
	"input_lra" : "0.00",
	"input_thresh" : "-70.00",
	"output_i" : "-inf",
	"output_tp" : "-1.50",
	"output_thresh" : "-70.00",
	"normalization_type" : "linear",
	"target_offset" : "inf"
}
```

ebur128 itself reports `I: -70.0 LUFS` for anything below ~0.4 s of audio (one 400 ms gating block
minimum). So the short-Clip caveat is: **below ~0.4–0.5 s, loudnorm cannot measure and therefore
cannot normalize; it only applies a TP-limited gain.** Peak of `clip_burst.mp3` went −13.7 →
−1.9 dBFS (mp3 re-encode overshoot of the −1.5 target) while integrated loudness stayed at the
−70 floor.

### 1b. Two-pass second stage: what the ticket guards need to know

The `measured_I=-inf` that the first pass actually prints **cannot be fed back**:

```bash
ffmpeg -i b_0.3.mp3 -af loudnorm=...:measured_I=-inf:offset=0:linear=true ...
# Error applying option 'measured_I' to filter 'loudnorm': Numerical result out of range
# [aost#0:0/pcm_s16le] Error initializing a simple filtergraph  → exit 1
```

Feeding finite hand-supplied values (the guard shape `measured_I=0.00:...:offset=-16.00:linear=true`)
exits 0 but does **nothing measurable**: output `I: -70.0 LUFS, Peak: -1.9 dBFS` — identical
loudness to input, only TP shaping. Two-pass on 0.3 s is a no-op with an error path, not a fix.

Two-pass on clips that are long enough works exactly:

```bash
# first pass (clip_3s.mp3, 3 s speech-like): input_i=-8.31 input_TP=0.22 input_lra=0.30
ffmpeg -i clip_3s.mp3 -af loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=-8.31:measured_TP=0.22:\
measured_LRA=0.30:measured_thresh=-18.31:offset=0.10,aresample=44100 -ac 1 \
  -c:a libmp3lame -q:a 4 tp_dyn.mp3
# → measure: I: -16.0 LUFS, Peak: -7.5 dBFS, 16553 bytes  (target hit within 0.0 LU)
```

| route | output I vs −16 target |
| --- | --- |
| single-pass dynamic, 5 s dense | −16.0 (±0.0) |
| single-pass dynamic, 5 s sparse (burst+silence) | **−9.0 (7 LU hot)** |
| two-pass with measured values, 5 s | −16.0 |
| two-pass with measured values, 3 s | −16.0 |
| any route, 0.3 s | unreachable (−70 floor), TP-only |

### 1c. Does it need a resample first? — No. After? — **Yes, always.**

loudnorm internally resamples to **192 kHz and leaves it there**:

```
$ ffmpeg -hide_banner -i clip_5s.mp3 -af loudnorm=I=-16:TP=-1.5:LRA=11 -c:a pcm_s16le ln_5s.wav
# ln_5s.wav: sample_rate=192000, channels=1   ← regardless of input rate (44.1k in)
$ ffmpeg -i p5_16k.wav -af loudnorm=I=-16:TP=-1.5:LRA=11 -c:a pcm_s16le ln16k.wav
# ln16k.wav: sample_rate=192000              ← 16k input, still 192k out
$ ffmpeg -i p5_16k.wav -af loudnorm=I=-16:TP=-1.5:LRA=11,aresample=16000 ...
# → 16000 Hz, I: -16.0 LUFS (vs -15.9 without the second resample — loudness unchanged)
```

**Rule: `loudnorm` must be followed by an explicit `aresample=<target>` filter (or `-ar`), or the
next stage silently receives 192 kHz.** A 16 kHz Silero VAD fed by this chain without the trailing
`aresample=16000` gets a wrong-rate buffer.

---

## 2. afftdn + highpass as pre-VAD cleanup

All at 16 kHz mono. Synthetic `src_stmt.mp4` (ground truth: statement 0–5.000, pause
5.000–5.200, statement 5.200–8.200; noise floor −36.1 dBFS RMS in the pause).

### 2a. Concrete args measured

Filter help (`ffmpeg -h filter=afftdn`): `nf` default −50 (range −80..−20), `nr` default 12
(0.01..97), `tn`/`tr` track noise/residual.

| filter chain | full-band RMS (whole file) | pause-window RMS (5.02–5.20) | speech-window RMS (1.0–4.0) | >4 kHz in pause |
| --- | --- | --- | --- | --- |
| `anull` (raw) | −24.54 dB | −36.12 dB | −23.62 dB | −39.46 dB |
| `highpass=f=80` | −24.60 | −36.14 | −23.68 | −39.46 |
| `highpass=f=200` | −26.04 | −36.22 | **−25.14** | −39.45 |
| `afftdn` (defaults nf=-50 nr=12) | −24.56 | −34.97 | −23.63 | −39.75 |
| `afftdn=nf=-25` | −24.94 | **−40.51** | −23.96 | **−51.51** |
| `highpass=f=200,afftdn` | −26.06 | −35.35 | −25.15 | −39.74 |

Readings:

- `afftdn=nf=-25`: noise floor drops 4.4 dB full-band, 12.1 dB above 4 kHz, speech loses 0.34 dB.
  This is the only variant with a good SNR trade.
- `afftdn` at defaults: **does essentially nothing** to this floor (−0.3 dB in-band), because the
  default `nf=-50` assumes a much quieter noise floor than a typical recording.
- `highpass=f=200`: kills 1.52 dB of the *statement* (fundamental/harmonics at 170–220 Hz live near
  the cutoff) while leaving the pause floor untouched (−36.22 vs −36.12). It costs speech and buys
  no separation.

### 2b. Do they shift detected boundaries? — **afftdn: yes, +23…+28 ms and it makes boundaries
detectable that raw misses entirely. highpass: no shift, no effect.**

Silencedetect sweep over thresholds (`noise=-30/-32/-34/-36 dB, d=0.1`) on the 200 ms pause:

```
raw / highpass=f=200 / afftdn(defaults) : no silence detected at ANY tested threshold
afftdn=nf=-25                          : silence_start: 5.027 → silence_end: 5.225
                                          (true 5.000 → 5.200; +27 ms / +25 ms)
```

Onset probe with known content edges (`ons_raw.wav`, statement starts at 1.000, ends at 6.000,
silencedetect at −38 dB):

```
anull (raw)                : NO boundary detected (noise peaks break every silence run)
afftdn=nf=-25              : silence_end 1.0238  (= onset +23.8 ms)
                             silence_start 6.0283 (= offset +28.3 ms)
highpass=f=200,afftdn=nf=-25: silence_end 1.0238  (= onset +23.8 ms; highpass adds ~0 ms)
```

Second probe (`n_burst_raw.wav`, true burst 1.000–1.300 over −36 dB noise, threshold −35 dB):

```
raw                : nothing detected
afftdn=nf=-25      : silence_end 1.0233 (start +23 ms), silence_start 1.3259 (end +26 ms)
highpass+afftdn    : silence_end 1.0239 (+24 ms),       silence_start 1.3267 (+27 ms)
```

Plainly: **`afftdn` shifts VAD/detected boundaries outward by ≈ +24–28 ms at each edge** (FFT
overlap smoothing) — boundaries get *found* where the noise floor previously hid them, at the cost
of ~25 ms of extra noise-edge on each side. `highpass` shifts nothing measurably (≈ +1 ms); it
neither helps nor hurts boundary detection, it only attenuates low-fundamental speech. Both effects
are inside the ±30 ms range a Fuzziness re-run should be treating as noise anyway.

---

## 3. Accurate cut: `-ss/-to` before vs after `-i`, copy vs re-encode

Probe: `src_onset.mp4`/`src_onset.mp3` — exact silence 0–3.000 s, speech 3.000–10 s.
Cut `-ss 2 -to 7` → ground truth: speech onset **1.000 s** inside the cut, length **5.000 s =
80 000 samples @16 kHz**. Onset measured by `silencedetect=noise=-45dB:d=0.3` on the decoded cut;
length by decoding to `s16le -ar 16000 -ac 1` and counting samples.

| # | method | onset in cut | drift | decoded samples | duration drift |
| --- | --- | --- | --- | --- | --- |
| A | mp4/aac `-ss 2 -to 7` **before** `-i`, `-c copy` | 1.000 | 0 ms | 80 199 | +12.4 ms |
| B | mp4/aac before `-i`, **re-encode** aac 128k | 1.000 | 0 ms | 80 248 | +15.5 ms (aac padding) |
| C | mp4/aac `-ss/-to` **after** `-i`, `-c copy` | **0.9799** | **−20 ms** | 79 877 | −7.7 ms |
| D | mp4/aac after `-i`, re-encode aac 128k | 1.000 | 0 ms | 80 248 | +15.5 ms |
| F | mp3 `-ss 2 -to 7` **before** `-i`, `-c copy` | 1.0016 | +1.6 ms | 80 056 | +3.5 ms |
| G | mp3 after `-i`, `-c copy` | **0.9756** | **−24 ms** | 79 638 | −22.7 ms |
| H | mp3 before `-i`, re-encode lame 128k | 1.000 | 0 ms | **80 000** | **0 ms** |

E — mp4→mp3 `-c copy` is not a thing at all:

```
$ ffmpeg -ss 2 -to 7 -i src_speech.mp4 -c copy -y E_copy.mp3
[mp3 @ ...] Invalid audio stream. Exactly one MP3 audio stream is required.
Could not write header (incorrect codec parameters ?)  → exit 1
```

(from an m4a/aac Source, any `-c copy` into an mp3/pcm Clip is refused; copy only stays in-container.)

Earlier duration-only cross-check on `src_speech.mp4` (same cut, no onset probe) agreed:
A probe=5.013 / 80 199 samples; C probe=5.013 / 79 877; F probe=5.0155 / 80 056; G probe=4.989 /
79 638; H probe=5.0416 / 80 000 (the mp3 probe duration includes encoder padding tags; the sample
count is what a decoder delivers).

Plainly:

- **Seek input options (`-ss`/`-to`) must come BEFORE `-i`.** After `-i` with `-c copy` the cut
  drifts −20 to −24 ms early on both container types (frame/timestamp alignment against the
  unseeked timeline).
- `-c copy` never gives an exact length: aac/mp3 frames round the cut up (up to +26 ms for a
  44.1 kHz mp3 frame, measured +3.5 ms here). Fine for speed, wrong for Range precision.
- Re-encode before `-i` gives onset exactly and, for mp3 out, **exactly 80 000 samples** (lame
  encoder delay is compensated). The aac muxer leaves +15.5 ms of decoded padding — small, but it
  is why a rendered Clip should be encoded to mp3 rather than staying aac if exactness matters.
- Streaming cut (no intermediate file) with pre-`-i` seek verified sample-exact too:

  ```
  $ ffmpeg -v error -ss 2 -t 5 -i src_onset.mp4 -af aresample=16000 -ac 1 -ar 16000 -f s16le - > stream_cut.raw
  # 160 000 bytes = 80 000 samples (expect 80 000); first non-silent sample: index 16 001
  # → onset = 1.0000625 s (error: 1 sample / 0.06 ms)
  ```

---

## 4. mp3 render matrix (3 s speech-like Clip, after loudnorm)

Command shape (one variant shown):

```bash
ffmpeg -i clip_3s.mp3 -af loudnorm=I=-16:TP=-1.5:LRA=11,aresample=44100 \
  -c:a libmp3lame -ar 44100 -ac 1 -q:a 4 -y r_mo44q4.mp3
```

| variant | args | bytes (3 s) | measured bitrate | output I | output TP |
| --- | --- | --- | --- | --- | --- |
| `st44b128` | `-ar 44100 -ac 2 -b:a 128k` | 49 043 | 128 000 CBR | −16.5 LUFS | −11.0 dBFS |
| `st44q4` | `-ar 44100 -ac 2 -q:a 4` | 18 505 | ~48.5 k VBR | −16.1 | −10.6 |
| `mo44b128` | `-ar 44100 -ac 1 -b:a 128k` | **49 043** | 128 000 CBR | −16.5 | −8.0 |
| `mo44q4` | `-ar 44100 -ac 1 -q:a 4` | 16 553 | ~43.3 k VBR | −16.1 | −7.5 |
| `mo24b128` | `-ar 24000 -ac 1 -b:a 128k` | 49 295 | 128 000 CBR | −16.5 | −8.0 |
| `mo24q4` | `-ar 24000 -ac 1 -q:a 4` | **11 783** | ~30.6 k VBR | −16.0 | −7.5 |
| `mo16q4` | `-ar 16000 -ac 1 -q:a 4` | 10 223 | ~26.0 k VBR | −16.0 | −7.5 |

Readings:

- **CBR `-b:a 128k` charges 128 kbit/s for mono too** — `mo44b128` (49 043 B) is byte-identical in
  size to `st44b128` (49 043 B) for the same duration: ~16 KB/s wasted on mono. If CBR is wanted,
  mono should be `-b:a 64k` (not measured here; not needed — VBR below beats it).
- **`-q:a 4` is the size win**: 44.1 k mono 16.5 KB/3 s (≈44 kbit/s); 24 k mono 11.8 KB/3 s
  (≈31 kbit/s). −q:a 4 at 44.1k mono is 3× smaller than 128k CBR with the same measured loudness.
- 24 kHz caps the spectrum at 12 kHz — inaudible loss for voice, and on the speech-like fixture the
  24 k render is 4.7 KB (29 %) smaller than 44.1 k. But the fixture is synthetic harmonics; real
  Sources carry mouth-noise/hiss above 12 kHz that a 24 k render would delete (never measured
  subjectively here).
- Loudness lands at −16.1…−16.5 with single-pass loudnorm (two-pass measured −16.0 exactly; see 1b).
- Render is bit-for-bit deterministic: two identical renders → same md5
  (`e9371ba75fadbb9e26f5f67b25e4f899` twice).

---

## 5. Streaming 16 kHz mono PCM into a Node pipe

Exact args (`exp/stream.js`, runnable self-check):

```js
const FF = require('ffmpeg-static');
const args = ['-hide_banner','-nostats','-v','error',
  '-i','src_speech.mp4',
  '-af','highpass=f=80,afftdn=nf=-25,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=16000',
  '-ac','1','-ar','16000','-f','s16le','-c:a','pcm_s16le','-'];   // '-' = stdout
const p = spawn(FF, args, { stdio: ['ignore','pipe','pipe'] });
```

Observed run (10 s source):

```
PASS1 plain: {"code":0,"total":320250,"frames":312,"ragged":74,"chunks":74,"leftover":762} expected=320000
PASS2 paused 300ms after 32KiB: {"code":0,"total":320250,"frames":312,"chunks":36,"leftover":762}
```

How frames are read: Node delivers **arbitrary chunk boundaries** — 74/74 chunks in PASS1 were *not*
a multiple of the 32 ms (512-sample = 1024-byte) VAD frame. So: keep a `leftover` Buffer, concat,
take `floor(len/1024)` frames, slice the remainder back. `leftover` was 762 bytes (< 1 frame) at
EOF. Nothing to align to on the wire — alignment is the reader's job.

Pitfalls actually hit:

1. **Trailing resampler tail**: 320 250 bytes received vs 320 000 expected (16 000 × 2 × 10 s) —
   +125 samples (~8 ms) of `aresample` flush at EOF. Don't assert exact byte counts at the stream;
   assert on the *cut* side (§3: `-ss/-to` before `-i` gave exactly 80 000 samples because that
   path re-frames through the mp3 encoder, not the raw stream).
2. **Backpressure**: `p.stdout.pause()` mid-stream (PASS2) blocks ffmpeg at `write()`; after
   `resume()` the byte total is unchanged — no drops, no OOM. Converse case: stdout piped but never
   read (`exp/stall3.js`, no `data` listener) leaves ffmpeg **RUNNING (blocked)** forever after
   3 s — kernel pipe buffer (~64 KB) full. Node's default flow pauses itself; ffmpeg is the one
   that stalls, so you must consume or explicitly `pause()/resume()`.
3. stderr must be consumed: with `-v error` volumes are tiny so not blocking here, but the rule
   stands — never leave a `stdio:'pipe'` stderr unread (any verbosity above error, e.g. filter
   debug/trace logging, fills the same 64 KB pipe). In `stream.js` stderr is drained to `/dev/null`
   equivalent (`data` → no-op write).
4. `-v error` + `-nostats` keeps stderr quiet enough that "no data" ≠ "alive"; treat child `close`
   code 0 as end-of-stream and flush `leftover` as the last partial frame (VAD implementations
   accept short final frames, or pad — pick one and keep it).

---

## Recommended pipeline (for #5)

```
1. ffmpeg decode, seek FAST:  -ss <Range.start> -t <len> -i Source   (BEFORE -i)
2. cleanup chain (default-on, single-pass, streamable):
      highpass=f=80,afftdn=nf=-25
3. resample + layout:         -ac 1 -ar 16000 -f s16le -              (stdout pipe)
4. Silero VAD → Ranges       (reads 512-sample frames from the leftover-buffered pipe)
5. Fuzziness re-run against stored Ranges (same cut path, step 1)
6. Clip render (two-pass loudnorm lives HERE, not pre-VAD):
      pass1: loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json  → parse measured_*
      pass2: -ss <start> -to <end> -i Source -af loudnorm=<measured…>,aresample=<rate>
             -c:a libmp3lame -ac 1 -q:a 4  (44.1 kHz default; 24 kHz flag)
7. whisper Transcript from the rendered Clip
```

- Default-on pre-VAD: `highpass=f=80` (near-free, hum/DC) + `afftdn=nf=-25` (measured 4.4/12.1 dB
  floor drop, 0.34 dB speech cost). **Not** loudnorm pre-VAD: it is non-measurable in streaming
  single-pass (dynamic mode overshot by 7 LU on sparse input), forces a 192 kHz detour, and the
  measured boundary effect comes from afftdn anyway (+24–28 ms) — worth knowing, well inside
  Fuzziness.
- Behind flags: `highpass=f=200` (costs 1.5 dB of speech), `afftdn` aggressiveness (`nf`, `nr`),
  24 kHz render, `LRA`/target overrides.
- Short-Clip caveat: any Clip shorter than ~0.5 s gets no loudnorm (measured: `input_i=-inf`,
  target unreachable, second pass errors on `-inf`); render it with peak-normalize to TP −1.5 dBFS
  instead.
- mp3 copy into an m4a/mp4 Source-adjacent `-c copy` is refused by the mp3 muxer; Clips are always
  re-encoded (measured: exact onset, exact sample count with lame).

## Docs-based research branch

`git fetch origin --prune` at time of writing shows only `origin/main` — **`research/ffmpeg-node`
has not landed**, so no disagreements can be quoted yet. Nothing in this doc rests on docs prose;
every number above came from the commands shown.
