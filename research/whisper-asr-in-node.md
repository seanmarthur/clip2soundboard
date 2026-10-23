# Research: Whisper ASR in Node

Scope: pick a local Whisper binding for a Node 24 CLI that transcribes short clips (~0.3–30 s, MP3) on a laptop CPU.

Environment used for verification: Node `v24.19.0`, npm `11.17.0`, Python `3.12.3`, g++/Make available; `cmake` **not** installed.

---

## Candidates compared

### 1. `@xenova/transformers@2.17.2` (Transformers.js Whisper)

| Question | Finding |
|----------|---------|
| Package + version verified | `@xenova/transformers@2.17.2` installed cleanly; `ffmpeg-static@5.3.0` installed alongside. |
| Install footprint | `node_modules` = ~333 MB; package itself ~45 MB, `onnxruntime-web` ~66 MB, `sharp` ~17 MB, `ffmpeg-static` binary ~77 MB. |
| Python needed? | **No.** Pure JS + ONNX Runtime WASM/Node. |
| Native build? | `sharp` has a native component; it installed via prebuilt binary on this machine. No cmake/g++ user build required. |
| Model source / cache | Downloads ONNX-converted Whisper checkpoints from Hugging Face (e.g. `Xenova/whisper-tiny.en`). Default cache dir is `~/.cache/transformers.js` unless `env.cacheDir` is set. Models are OpenAI Whisper weights (MIT-licensed) ported to ONNX by Xenova. |
| Model sizes (downloaded, approximate) | tiny.en ~75 MB; base.en ~150 MB; small.en ~466 MB. |
| CPU speed | **UNVERIFIED in this run** — the package loaded and the pipeline API was exercised only to the point of import; no actual transcription timing captured. |
| Hardware accel | Uses ONNX Runtime. GPU execution would require an `onnxruntime-node`/`onnxruntime-web` backend swap and a CUDA/Metal/DirectML build; **UNVERIFIED**. |
| Structured JSON output | Pipeline returns a JS object/array natively; `return_timestamps: 'word'` or `'chunk'` is supported by the Whisper pipeline per docs/API. Actual JSON shape on our clips: **UNVERIFIED**. |
| Word-level timestamps | Supported in API via `return_timestamps: 'word'`; actual accuracy on sub-second/synthetic clips: **UNVERIFIED**. |
| Sub-second clip behavior | Synthesized 0.3 s clip was generated, but not yet fed through the model; behavior on sub-second inputs: **UNVERIFIED**. |

### 2. `nodejs-whisper@0.4.0` (whisper.cpp Node-API wrapper)

| Question | Finding |
|----------|---------|
| Package + version verified | `npm view nodejs-whisper` confirms `0.4.0`, MIT, 37 MB unpacked. **Not installed** because the install script (`scripts/build-native.js`) invokes `cmake`, which is absent in this environment. |
| Install footprint | ~37 MB npm tarball; installed footprint would be larger after compiling the Node-API addon and downloading models. |
| Python needed? | Likely no Python at runtime, but build step needs cmake + C++ toolchain. |
| Native build? | Yes — builds whisper.cpp into a Node addon at install time. |
| Model source / cache | Ships a `downloadModel.js` helper that pulls ggml Whisper models (OpenAI/whisper.cpp model repo, MIT license). |
| Model sizes | Same ggml binaries: tiny.en ~75 MB, base.en ~142 MB, small.en ~466 MB. |
| CPU speed, hardware accel, JSON/word timestamps, sub-second behavior | **UNVERIFIED** — package did not build. |

### 3. `whisper-node@1.1.1`

| Question | Finding |
|----------|---------|
| Package + version verified | `npm view whisper-node` confirms `1.1.1`, MIT, 8 MB unpacked, last published 2023-11-29. **Not installed** in this run. |
| Install footprint | Small tarball; runtime needs a whisper.cpp binary and model files. |
| Python needed? | No Python required by the wrapper itself; it shells out via `shelljs`. |
| Native build? | No build at install, but depends on a separately built `whisper.cpp` binary. |
| Model source / cache | Ships a `download.js` script that fetches ggml models. |
| CPU speed, hardware accel, JSON/word timestamps, sub-second behavior | **UNVERIFIED**. |

### 4. Shell out to a `whisper.cpp` binary

| Question | Finding |
|----------|---------|
| Approach | Use `child_process.spawn` to call a prebuilt or self-compiled `whisper-cli`/`main` binary. |
| Install footprint | Only the binary (~few MB) + ggml model files. No npm package for the engine itself. |
| Python needed? | No. Build needs g++/Make; prebuilt releases avoid that. |
| Native build? | `make` build of whisper.cpp works without cmake. AVX/AVX2/FMA/Metal/CUDA backends available at compile time. |
| Model source / cache | Download ggml models from whisper.cpp’s model download scripts (OpenAI weights, MIT). |
| Model sizes | Same as above. |
| CPU speed | Typically the fastest option on CPU because it is a dedicated C++ inference binary. No measurement taken in this run: **UNVERIFIED**. |
| Structured JSON output | `whisper.cpp` supports `--output-json --output-file`. |
| Word-level timestamps | Supported with `--word-timestamps`. |
| Sub-second clip behavior | Whisper.cpp handles short files; accuracy on <1 s synthetic tones: **UNVERIFIED**. |

---

## Empirical work done

- Created a bench area at `/tmp/asr-scout/tf` and ran:
  ```bash
  npm install @xenova/transformers@2.17.2 ffmpeg-static@5.3.0
  ```
  Installation succeeded in ~8 s.
- Used `ffmpeg-static` to synthesize test audio:
  - `audio/tone-0.3.wav` — 0.3 s 440 Hz sine, mono 16 kHz.
  - `audio/tone-5.wav` — 5 s 440 Hz sine, mono 16 kHz.
  - `audio/tone-5.mp3` — MP3 encode of the 5 s tone.
  - `audio/jfk.wav` — downloaded the standard 11 s JFK sample from the whisper.cpp repo.
- Did **not** complete an actual transcription pass with any candidate before this artifact was cut off.

---

## Recommendation

**Primary:** `@xenova/transformers@2.17.2`  
Reason: it is the only candidate that installed and loaded under Node 24 in this environment with no cmake/Python/toolchain dependency. It gives JavaScript-native structured output and supports word-level timestamps via `return_timestamps: 'word'`.

**Fallback:** `nodejs-whisper@0.4.0`  
Reason: if the build environment is available (cmake + C++ toolchain), it should be the fastest fully-integrated Node option because it binds directly to whisper.cpp. If the wrapper proves flaky, fall further back to shelling out to a `whisper.cpp` binary.

**Before accepting either recommendation, verify:**

1. Actual transcription of `tone-0.3.mp3`, `tone-5.mp3`, and `jfk.wav` with `@xenova/transformers` and measure CPU real-time factors for tiny.en/base.en/small.en.
2. Whether `return_timestamps: 'word'` returns usable JSON for sub-second clips.
3. Whether installing `nodejs-whisper@0.4.0` succeeds in an environment with cmake, and whether its JSON/word-timestamp output matches the API.
4. Whether `whisper-node@1.1.1` or a direct `whisper.cpp` shell-out is faster and more reliable than the pure-JS option.
