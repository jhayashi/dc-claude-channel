# Voice Transcription

## Feature: Voice transcription

### Intended behavior

The plugin intercepts voice messages (Delta Chat `.m4a` files with `viewType='Voice'`) and transcribes them offline using `@napi-rs/whisper` (native bindings to whisper.cpp). Transcription runs in a dedicated Worker thread to avoid blocking the event loop during the heavy `whisper.full()` inference call.

On successful transcription, the plaintext is prepended to the user's message as `[Voice transcript]: <text>`. In `echo=quoted` mode, the transcript is echoed back to the chat with a 🎙️ reaction; in `echo=silent` mode, it is transcribed but not shown. Sub-0.5-second clips are silently dropped (audio too short). Transcription is enabled/disabled via `DC_STT_ENABLED` environment variable.

### State machine / transitions

- **Detect** — `runSubagentTurn()` checks if message is voice (`viewType=Voice` + file path). If not, passes through unchanged.
- **Bootstrap gate** — Waits for bootstrap readiness (native module install must complete). Returns null on timeout (proceeds with untranscribed message).
- **Model download** — `ensureModel()` checks if whisper model file exists on disk. If not, downloads from Hugging Face, verifies SHA-256 against pinned hash from `whisper-model-hashes.json`, and atomically renames into `~/.claude/channels/deltachat/whisper-models/`.
- **Reaction: listening** — Sends 👂 reaction to user's message while loading model/starting transcription.
- **Decode** — Synchronously on main thread: `@napi-rs/whisper.decodeAudio()` parses `.m4a` (via Symphonia codec) into Float32Array samples, calculates duration (samples / 16000 Hz).
- **Duration checks** — If < 0.5s, throw `AudioTooShortError` (dropped silently). If > `maxDurationSec`, reject. Otherwise proceed to Worker.
- **Worker dispatch** — Post message to `stt-worker.ts` with `{ id, filePath, modelPath, modelName, maxDurationSec }`. Worker caches the Whisper instance per modelPath.
- **Transcription** — `Whisper.full()` on Float32Array, collect segments via `onNewSegment` callback. Language=`en` for `.en` models, `auto` (detect + transcribe) for multilingual models.
- **Echo** — If `echo=quoted`, send transcript to chat with 🎙️ reaction + thinking emoji.
- **Enrich message** — Return message object with text prepended: `[Voice transcript]: ${result.text}${original.text}`.
- **Timeout** — If Worker transcription exceeds `timeoutSec`, terminate Worker and reject with timeout error. Caller logs and proceeds with original message.

### Persisted state

**Model cache:** `~/.claude/channels/deltachat/whisper-models/ggml-<model>.bin` (downloaded once per model, shared across chats).

**Hash pinning:** `plugin/whisper-model-hashes.json` — JSON map of model names to expected SHA-256 hashes. Sourced from Hugging Face LFS metadata. Forward-compatible: if a model is unpinned, download is accepted with a warning.

**Worker state:** Single global Worker instance (lazy-init in `getWorker()`). Caches a single Whisper instance (in-memory) per modelPath to avoid reload cost. Resets on error.

### Observable surface

**Environment variables:**
- `DC_STT_ENABLED` — (default: `true`) Disable STT if set to `false` (case-insensitive).
- `DC_STT_MODEL` — (default: `base.en`) Model size/language: `tiny.en`, `base.en`, `base`, `small`, `medium`, `large`, etc.
- `DC_STT_ECHO` — (default: `quoted`) `quoted` = echo transcript back to chat; `silent` = transcribe but don't echo.
- `DC_STT_TIMEOUT_SEC` — (default: `120`) Transcription wall-clock timeout.
- `DC_STT_MAX_DURATION_SEC` — (default: `300`) Reject audio longer than this.
- `DC_STATE_DIR` — (default: `~/.claude/channels/deltachat`) Base directory for whisper-models cache.

**Config parsing:** `parseSTTConfig(env)` validates and returns STTConfig struct with defaults.

**Constants:**
- `MIN_AUDIO_DURATION_SEC = 0.5` — Clips shorter than this throw `AudioTooShortError` and are silently dropped.

**Reactions:**
- 👂 during decode/model-download phase.
- 🎙️ on the echoed transcript message (echo=quoted mode only).
- 🤏 (pinched hand) on the original voice message if dropped for being too short.

**Interception point:** `tryTranscribeVoice()` called from `runSubagentTurn()` before subagent dispatch.

### Primary source files

- `plugin/stt.ts` — Main transcription API: `parseSTTConfig`, `ensureModel`, `transcribe`, `isVoiceMessage`, `AudioTooShortError`, Worker pool.
- `plugin/stt-worker.ts` — Worker thread handler; owns cached Whisper instance; calls `whisper.full()` with language detection.
- `plugin/server.ts` — `tryTranscribeVoice` integration in `runSubagentTurn`.
- `plugin/whisper-model-hashes.json` — Pinned SHA-256 hashes for supported models.
- `plugin/package.json` — Dependency on `@napi-rs/whisper`.

### Audit notes

Voice transcription is a pre-processing step; it does not itself call tools. The enriched message (with `[Voice transcript]:` prefix) is passed to the subagent. Any subsequent tool calls made during the turn are audited normally if skip-permissions is enabled. The transcript is visible in the turn history and reconstructable from chat export.
