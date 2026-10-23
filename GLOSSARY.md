# clip2soundboard

CLI that takes local video clips and extracts replayable human-voice statements as soundboard-ready audio.

## Language

**Source**:
A local video file (Twitch VOD clip, OBS recording, any short-form video) fed to the CLI.
_Avoid_: input, video, stream

**Statement**:
A stretch of human voice in a Source with the shape of one utterance — typically a short, meme-worthy saying.
_Avoid_: moment, soundbite, segment

**Range**:
The remembered start/end boundaries of one Statement, persisted between runs so later runs can adjust it. Ranges are the store of knowledge about a Source, not ephemeral output.
_Avoid_: timestamp pair, interval

**Fuzziness**:
The tolerance applied when re-running a Source: how far a Statement's boundaries may grow/snap to capture audio (pauses, background noise) that the first run clipped too tight.
_Avoid_: padding, tolerance, sensitivity

**Clip**:
The audio file rendered from one Statement's Range. This is the deliverable loaded into a soundboard.
_Avoid_: export, track

**Transcript**:
The text of one Clip, produced so a controlling agent can reason about whether the Statement is coherent, nonsense, or a deliberate joke. It aids judgement; it never decides which Statements are kept.
_Avoid_: caption, subtitle, ASR output
