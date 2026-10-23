# VAD owns boundaries; ASR owns text

Distinguishing human-voice Statements in a clip is a boundary problem, and we run Silero VAD to find Statement Ranges rather than deriving them from speech-to-text word timestamps. Whisper (whisper.cpp, local) runs only to produce a Transcript per Clip; coherence judgement about whether a Statement is coherent or nonsense belongs to the controlling agent reading Transcripts, never to the CLI.

Rationale: whisper word timestamps are tuned to readability, not audio-edge precision — they pad, merge and drift on pauses, laughter and noise, which is exactly the material meme clips are made of. A VAD model at 16kHz mono gives cheap, streamable, frame-accurate speech/probability data, and keeps knowledge-based decision (is this funny/incoherent?) in the hands of the agent or human instead of burying it in one opaque model. The trade-off: we maintain two audio passes (detect, then transcribe) instead of one.

## Considered options

- Whisper word-timestamp-driven segmentation: fewer stages, worse boundaries, collapses detection and judgement into one model.
- ffmpeg `silencedetect` alone: free and dependency-free, but can't tell voice from music or sfx.

## Consequences

- Detection pass stores enough VAD detail (frame probabilities or silence valleys) for the Fuzziness re-run algorithm to re-find boundary candidates without re-recording them ad hoc.
- Clips are transcribed after render, so a re-fuzzed Clip re-transcribes cleanly rather than offsetting word timestamps.
