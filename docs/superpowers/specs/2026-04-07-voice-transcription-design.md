# Voice Message Transcription (v0.8.3)

Transcribe Delta Chat voice messages locally so Claude can respond to them as if the user had typed.

## Goals

- Voice messages (`viewType === 'Voice'`, `.m4a` from DC mobile) arrive as empty-text messages today and are effectively dropped.
- After this change, the `.m4a` is transcribed locally via whisper.cpp and the transcript becomes the message text — downstream code is unchanged.
- Zero API keys, zero cloud dependency. Offline-first, matches Delta Chat's "own your data" ethos.

## Non-Goals

- Cloud STT providers (OpenAI Whisper API, Deepgram, etc.). Can be added later behind a flag; not shipping in v0.8.3.
- Outbound TTS (Claude speaking back as audio).
- Real-time streaming transcription. Voice messages are always complete files.
- Multilingual by default. English-only base model ships; users can override.

## Architecture

```
DC voice msg (.m4a)
        │
        ▼
  dc-client.ts
  IncomingMsg handler
        │
        │  viewType === 'Voice' ?
        │  (or audio/* mime)
        ▼
  stt.ts::transcribeAudio(path)
        │
        │  1. ensure model present (lazy download)
        │  2. ffmpeg .m4a → 16kHz mono wav
        │  3. nodejs-whisper transcribe
        │
        ▼
  msg.text = transcript
        │
        ▼
  server.ts routing
  (echo mode applied here)
        │
        ▼
  Claude session
```

## New Module: `plugin/stt.ts`

```ts
export interface STTConfig {
  enabled: boolean
  model: string     // e.g. 'base.en'
  echo: 'quoted' | 'confirm' | 'silent'
}

export function loadSTTConfig(): STTConfig
export async function transcribeAudio(path: string, cfg: STTConfig): Promise<string>
export async function ensureModelReady(cfg: STTConfig): Promise<boolean>  // false if ffmpeg missing
```

- Wraps `nodejs-whisper` (npm). Auto-downloads the configured model on first use.
- Converts `.m4a` → `.wav` (16 kHz mono) via `ffmpeg` — whisper.cpp's required input format.
- Caches the model in `~/.claude/channels/deltachat/whisper-models/`.
- On any failure, throws an `STTError` with a user-readable reason.

## Hook: `dc-client.ts` IncomingMsg

Extend the existing handler:

```ts
if (snap.viewType === 'Voice' && snap.file && sttCfg.enabled) {
  try {
    const transcript = await transcribeAudio(snap.file, sttCfg)
    snap = { ...snap, text: transcript }
  } catch (err) {
    snap = { ...snap, text: `[voice message — transcription failed: ${err.message}]` }
  }
}
```

The rest of the pipeline treats it as a normal text message.

## Echo Modes (server.ts)

Applied just before routing the Message to Claude:

| Mode | Behavior |
|------|----------|
| `quoted` (default) | No extra message. Claude's reply is expected to quote/reference the transcript so the user can verify accuracy. |
| `confirm` | Bot sends `🎤 heard: <transcript>` back to the chat first, then routes the message to Claude. |
| `silent` | No echo. The voice message disappears from the user's view — Claude's reply stands alone. |

## Configuration (`.env`)

| Var | Default | Notes |
|-----|---------|-------|
| `DC_STT_ENABLED` | `true` | Set `false` to disable entirely |
| `DC_STT_MODEL` | `base.en` | Any nodejs-whisper model id: `tiny.en`, `base.en`, `small.en`, `base`, `small`, etc. |
| `DC_STT_ECHO` | `quoted` | One of `quoted`, `confirm`, `silent` |

## Dependencies

- **npm:** `nodejs-whisper` (new). Installs via `bun install`. No native build — it downloads prebuilt whisper.cpp binaries.
- **system:** `ffmpeg`. Checked once at startup; if missing, STT is disabled with a single log line and the plugin continues to run normally. No voice-message support, but no crash.

## First-Run UX

On the first voice message after install (when the model isn't cached yet):

1. Bot sends a status message to the chat: `⏳ Downloading transcription model (one-time, ~150MB)…`
2. Model downloads in the background.
3. On completion, transcription proceeds normally and the first transcript is delivered.

Subsequent voice messages skip the download step — model is cached.

## Error Handling

| Failure | User sees | Log |
|---------|-----------|-----|
| ffmpeg missing | `[voice message — transcription unavailable: ffmpeg not installed]` | warn once at startup |
| Model download fails | `[voice message — model download failed: <err>]` | full error |
| Transcription fails mid-run | `[voice message — transcription failed: <err>]` | full error |
| STT disabled via env | Message delivered with empty text (current behavior, no regression) | nothing |

## Testing

- **Unit:** mock `nodejs-whisper`; verify IncomingMsg branch transforms Voice messages, passes non-Voice through unchanged.
- **Unit:** verify each echo mode produces the expected side effects (reply sent / not sent).
- **Unit:** verify ffmpeg-missing path returns the specific error string and doesn't throw.
- **Integration (optional, skipped in CI):** real ffmpeg + a tiny sample .m4a through `tiny.en` model to verify end-to-end happy path. Gated behind `RUN_STT_INTEGRATION=1`.

## Out of Scope / Deferred

- Cloud STT providers — clean extension: add `DC_STT_PROVIDER=openai|deepgram` later; the transcribeAudio interface stays.
- Streaming partial transcripts as the user is still recording — not possible with DC's message model anyway.
- Speaker diarization, timestamps — not useful for a chat bot flow.

## Rollout

- Ships in v0.8.3 alongside the file-reviewer and auto-pair fixes.
- Opt-out via `DC_STT_ENABLED=false` for anyone who doesn't want whisper installed.
- No schema changes, no breaking changes, no migration needed.
