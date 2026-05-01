# dc-claude-channel — architecture

Full file/component inventory for the Delta Chat plugin. Updated as the codebase changes; CLAUDE.md links here for the long form.

## Top-level layout

- `plugin/server.ts` — Dispatcher entry point. Owns the DC RPC connection, the MCP server for the user's terminal Claude Code session, and the Unix-socket server that subagents connect to.
- `plugin/dispatcher/` — Subagent-per-chat machinery (v0.9+):
  - `subagent-cache.ts` — Bounded LRU cache of persistent `claude -p` processes, one per recently active chat (default 8 active, 15 min idle timeout)
  - `subagent-process.ts` — Wraps one persistent `claude -p` child with stream-json I/O over stdin/stdout
  - `socket-server.ts` — Unix socket listener with hello auth + frame routing
  - `permission-hook.sh` + `permission-hook-client.ts` — PreToolUse hook that forwards built-in tool permission prompts from the subagent to the dispatcher; dispatcher relays to the existing permissions-app WebXDC flow
  - `hook-config.ts` — Generates per-subagent settings.json
  - `message-router.ts` — Classifies incoming DC events (regular, system, ChatModified, unpaired) and dispatches
  - `schedule-store.ts` — Per-chat persistence for scheduled jobs (one JSON file per job)
  - `scheduler.ts` — In-process cron scheduler; arms one `setTimeout` for the nearest fire and dispatches synthetic user turns through `subagentCache.dispatch` when jobs fire
  - `trust-filter.ts` — Helpers used by `dc_chat_history` / `dc_download_attachment` to redact unpermissioned-sender content (v1.2.2+)
- `plugin/shared/protocol.ts` — Wire protocol types + Zod schemas (single source of truth for socket frames)
- `plugin/webxdc-app.ts` — `WebXDCApp` interface that all apps implement
- `plugin/apps.ts` — App registry (explicit imports, no auto-discovery)
- `plugin/apps/` — App implementations:
  - `file-reviewer-app.ts` — File reviewer: rendered markdown + syntax-highlighted source + inline commenting (1 tool, event-driven updates). Auto-detects Marp decks (YAML frontmatter `marp: true`, or a no-frontmatter doc that starts with `---\n` and splits into 2+ sections) and renders them as an interactive slide deck with slide-aware comment anchors. Detection in `plugin/marp-detect.ts`. `dc_send_slides` is a thin alias to `dc_send_file`.
  - `permissions-app.ts` — Permission prompt via WebXDC (notification handler + polling). Phase 2: requires explicit `chat_id` on every request.
  - `agent-setup-app.ts` — Agent setup card: pick an existing agent or create a new one; creates the DC chat + persists agent + binding on confirm.
- `plugin/agents.ts` — Agent definition registry (YAML, reusable, matches Claude Managed Agents schema)
- `plugin/bindings.ts` — Per-chat binding records (chat ↔ agent link + session UUID + inheritClaudeMd)
- `plugin/agent-setup.ts` — XDC builder for the agent setup WebXDC app
- `plugin/dc-client.ts` — Wraps `@deltachat/jsonrpc-client` + `@deltachat/stdio-rpc-server`
- `plugin/access/` — File-based allowlist + pairing codes (~/.claude/channels/deltachat/approved/). Split (v1.1.2+) into `chat-allowlist.ts` (persistent `approved/<chatId>` store), `pairing.ts` (in-memory arm window + pending codes), `principals.ts` (per-contact identity records — see CLAUDE.md "Principals" section), and `index.ts` (the barrel every call site imports).
- `plugin/tutorial.ts` — Onboarding tutorial state machine
- `plugin/webxdc-filter.ts` — Centralized owner verification for WebXDC updates
- `plugin/events.ts` — Structured JSONL log of every DC tool call
- `plugin/schedule-import-export.ts` — `.schedules.yaml` round-trip schema + helpers (v1.2.2+)
- `plugin/test/webxdc/` — Tier-1 WebXDC test harness (opt-in; Playwright-based). Isolated `package.json` so marketplace installs pay zero cost. See `plugin/test/webxdc/README.md` for contributor bootstrap.
- `plugin/test/integration/` — Tier-2 integration harness (v1.1.5+; opt-in via `DC_INTEGRATION_TEST=1`). Real `@deltachat/stdio-rpc-server` driving two accounts on a local `chatmail/docker` container. Bootstrap: `cd plugin/test/integration/chatmail-docker && ./podman-run.sh up` (or `docker compose up -d`). Then `bun run test:integration` from `plugin/`. Slices: `pairing.test.ts` (pair + text round-trip, free), `subagent-lifecycle.test.ts` (real `claude -p` spawn + reply, gated by `DC_TEST_SUBAGENT=1` — incurs ~1 Anthropic turn per run). See `plugin/test/integration/README.md`.

## State directory

`~/.claude/channels/deltachat/`:

- `.env` — local environment overrides
- `dc-data/` — Delta Chat account database (managed by dc-core)
- `approved/<chatId>` — chat-allowlist + per-chat owner contactId (legacy; see Principals for v1.2.2+ read path)
- `principals/humans/<contactId>.json` — per-contact identity records (v1.1.5+)
- `agents/<agentId>.yaml` — reusable agent definitions
- `bindings/<chatId>.json` — per-chat agent binding + session UUID
- `schedules/<chatId>-<jobId>.json` — scheduled jobs
- `session-agents/<sessionId>.json` — session→agent index for resume
- `agent-badges/` — rendered PNG cache (regenerable via `bun run build:badges`)
- `events/` — JSONL audit logs (`tools-*.log`, `turns-*.log`, `permissions-*.log`, `webxdc-*.log`)
- `familiars/` — persistent Familiar app state + handler source
- `dispatcher.sock` — Unix socket subagents connect to
- `debug.log` — dispatcher debug stream

## Voice transcription (v1.0+)

Voice messages (.m4a) are transcribed locally via `@napi-rs/whisper` (prebuilt native bindings to whisper.cpp) before reaching the subagent. No system dependencies required — no cmake, no g++, no ffmpeg. Just `bun install` and it works.

The dispatcher intercepts voice messages in `runSubagentTurn`, decodes audio natively via Symphonia (`decodeAudio()`), runs whisper inference in-process, and prepends `[Voice transcript]: <text>` to the message text. The subagent sees a normal text message with `source=voice` metadata.

Config (environment variables):
- `DC_STT_ENABLED` — `true` (default) or `false`
- `DC_STT_MODEL` — ggml model name (default `base.en`). Models are auto-downloaded from Hugging Face on first use to `$DC_STATE_DIR/whisper-models/`.
- `DC_STT_ECHO` — `quoted` (default, echoes transcript back to chat) or `silent`
- `DC_STT_TIMEOUT_SEC` — max transcription runtime (default `120`)
- `DC_STT_MAX_DURATION_SEC` — max audio length to attempt (default `300`)

Files:
- `plugin/stt.ts` — Core transcription module (config, model download, native audio decoding, transcription via @napi-rs/whisper)
- `plugin/test/stt.test.ts` — Unit tests for config parsing, voice detection
