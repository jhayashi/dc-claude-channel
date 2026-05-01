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

## Agent model (v0.10+)

An "agent chat" is a DC chat bound to a reusable **agent definition** (name, model, system prompt, tools) via a per-chat **binding** record that also holds the claude session UUID used for `--resume`.

Three concerns, three storage locations:

- **Agent definitions** — portable YAML files in `~/.claude/channels/deltachat/agents/<agentId>.yaml`. Schema matches Claude Managed Agents (`name`, `model`, `system`, `tools`) with `x-dc-createdAt` for the creation timestamp. Reusable across chats — one definition may be bound to many DC chats at once. Managed by `plugin/agents.ts`.
- **Bindings** — host-local JSON files in `~/.claude/channels/deltachat/bindings/<chatId>.json`. Each record links a chat to an agent and holds runtime state: `agentId`, `sessionId` (for `--resume`), `inheritClaudeMd` flag, `createdAt`. Deleted on unpair; agent definitions are NOT deleted because they're reusable. Managed by `plugin/bindings.ts`.
- **Subagent processes** — ephemeral `claude -p` children in an LRU cache, spawned on demand. See "Subagent model" below.

`inheritClaudeMd` lives on the **binding**, not the agent, because it's a host-local/environment concern (whether to include the dispatcher's `CLAUDE.md` in the spawn) — an exported agent YAML should not carry host-specific assumptions.

Editing an agent definition **mutates in place**: changes apply on the next turn in every chat bound to that agent. The resumed claude session keeps its prior history, so the next turn runs under the new prompt but "remembers" things said under the old one. Usually fine; if you want a clean slate, start a new chat.

**Import/export (v0.10+):** Agent definitions can be exported as `.yaml` files via the agent-setup WebXDC card ("Export" button) and imported by sending a `.yaml` file attachment into any paired DC chat. The dispatcher intercepts `.yaml` attachments before the subagent sees them: valid definitions are saved (with automatic ID collision resolution via `-2`, `-3`, etc. suffixes); invalid YAML is rejected with an error message and the attachment is forwarded to the subagent. Export sends the full agent definition including `x-dc-*` metadata. Bindings (host-local chat mappings) are not exported — the user creates a new chat via the agent-setup card after importing. Round-trip compatible with Claude Managed Agents API YAML format.

**Wall + coach + mash-up (v1.2.0+, default-on):** agent creation opens on a 26-tile specialty wall (155 leaves grouped by L2). The user filters or drills into a tile, opens a leaf detail card, optionally stacks 1–3 leaves via "pairs with" chips into a mash-up, then taps Build & start chatting. A coach state machine then asks 1–3 short questions (parameter / lead / voice / tools) and graduates by assembling a plain-prose 5-paragraph system prompt: Identity, Expertise (per leaf), Voice (preset+sliders), Preferences (the user's own words, quoted as data not directives), Scope (tools + per-leaf liability frames). Spec at `plugin/docs/superpowers/specs/2026-04-28-agent-creation-redesign-design.md`. Files: `plugin/leaves.ts` + `plugin/leaves/*.yaml` (catalog), `plugin/coach.ts` (state machine), `plugin/prompt-assembler.ts` (5-paragraph composer + incremental refine), `plugin/personality-presets.ts`, `plugin/liability-frames.ts`, `plugin/webxdc/agent-setup.html` (wall + coach UI). The legacy v1.x template-grid flow (`plugin/templates.ts`) is still reachable behind `DC_NEW_AGENT_FLOW=0` for users who want it; slated for removal in a future release. Every agent carries `x-dc-archetype` (`role` / `utility` / `project`) — drives the runtime badge palette ("Agent badges" below).

**New-chat mode picker (v1.2.1+):** "Start a new chat" from the home card lands on an intermediate three-card screen (`#new-chat-mode`) before the wall: **Default agent** (one-tap, binds the built-in default), **Reuse a saved agent** (opens `#reuse-picker` with every saved agent's badge + binding count), **Build a custom agent** (the v1.2.0 wall flow, unchanged). All three paths funnel through the same confirmation modal with a processing spinner — emits `start-default-chat` / `start-reuse-chat` / `build-agent` payloads, dispatcher replies with `chat-ready` / `chat-failed`. Custom-build paths (single-leaf "Build now" + mash-up "Build & start chatting") gained the same modal in v1.2.1 — dispatcher's `handleBuildAgent` now returns the new chat id so the source card can confirm. The default agent is an undeletable built-in (`agents.ensureDefaultAgent`) auto-seeded on first use; manage / edit / delete behave like any other agent. Spec at `plugin/docs/superpowers/specs/2026-04-30-new-chat-picker-design.md`.

**Refine flow (v1.2.0+):** after an agent is bound to a chat, saying "let's refine you" / "be sharper on X" / similar (`plugin/nl-intents.ts` classifier) opens a one-question coach session over the existing agent. The user's answer becomes a new preference; `refineSystemPrompt` splices it into the existing system prompt's Preferences paragraph in place (no new agent, no badge swap, no session rebind). The cached subagent is evicted so the next message cold-spawns under the rewritten prompt. Triggers `refine-complete` lifecycle event. Files: `plugin/coach.ts:startRefineCoach`, `plugin/prompt-assembler.ts:refineSystemPrompt`, `plugin/apps/agent-setup-app.ts:graduateRefineSession`.

**NL meta-commands (v1.2.0+):** in any bound chat, three intents short-circuit before subagent dispatch — model-switch ("switch to opus"), trust-toggle ("trust me" / "be safer"), refine ("let's refine you"). Classifier in `plugin/nl-intents.ts`; dispatcher wiring in `plugin/nl-intent-handler.ts`. All three evict the cached subagent on success so the next message picks up the change immediately.

**Per-agent tool access (v0.10+):** Each agent definition can restrict which built-in tools and MCP servers its subagent is allowed to use via two optional fields: `allowedBuiltinTools` (string array or null) and `allowedMcpServers` (string array or null). `null` or absent means "all tools/servers allowed" (the default for new agents); `[]` means "none." Each `allowedMcpServers` entry is a server prefix (e.g., `dc`, `claude_ai_Gmail`, `plugin_telegram_telegram`). Built-in tools have fine-grained per-tool control; MCP servers are all-or-nothing toggles. Restrictions are enforced at spawn time via `--allowedTools` CLI flag with `mcp__<prefix>` entries for each enabled server. The agent-setup WebXDC card includes a collapsible tool picker: per-tool checkboxes for built-in tools, per-server toggles for MCP servers. Changes take effect on next subagent spawn (idle timeout or restart).

**Forward compat:** the `tools: []` field is written on every agent as a no-op hook. Per-agent tool capability restrictions use the separate `allowedBuiltinTools` and `allowedMcpServers` fields instead.

Sample files on disk:

```yaml
# ~/.claude/channels/deltachat/agents/marketing-agent.yaml
id: marketing-agent
name: Marketing Agent
model: claude-sonnet-4-6
system: |
  You are a marketing specialist...
tools: []
x-dc-createdAt: 2026-04-09T12:34:56.000Z
```

```json
// ~/.claude/channels/deltachat/bindings/42.json
{
  "chatId": 42,
  "agentId": "marketing-agent",
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "inheritClaudeMd": false,
  "workingDir": "/home/user/src/myproject",
  "createdAt": "2026-04-09T12:34:56.000Z"
}
```

## Subagent model (v0.9+)

Every paired chat that recently sent a message has a persistent `claude -p` subagent process handling it. Subagents are kept alive in an LRU cache bounded by `DC_SUBAGENT_MAX_ACTIVE` (default 8) so the common case — a small number of active chats — gets sub-second turnaround after the first cold spawn (~6 s). Idle subagents self-exit after `DC_SUBAGENT_IDLE_TIMEOUT_MIN` (default 15 minutes). The dispatcher's own MCP server stays running for the user's terminal Claude Code session — only per-chat messaging is rerouted through subagents.

Subagents run with `--permission-mode default` and the built-in CWD sandbox. When Claude wants to run a tool like Bash or Edit, a PreToolUse hook fires, connects to the dispatcher's Unix socket, and blocks waiting for a verdict. The dispatcher forwards the prompt to the existing permissions-app WebXDC flow in the bound chat and writes the user's Allow/Deny back to the hook. This preserves the v0.8.3 permission UX exactly while adding per-chat targeting (no `lastActiveChatId` TOCTOU).

DC tool calls (`dc_send`, `dc_send_file`, `dc_chat_history`, etc.) from a subagent flow through a tools-proxy MCP server loaded in that subagent, over the same Unix socket. Tool calls are gated by the owner's global paired-chats allowlist — a subagent can read or post into any chat the owner has paired, not just its own. Chat-scoping is **not a privacy/security boundary** between paired chats; it's a **context-hygiene default** — a subagent's own chat is the natural working context, but cross-chat reads (via `dc_chat_history`) or writes (via `dc_send_*`) are intentionally reachable when the agent needs to pull or push context across chats. Treat chat_id as "which chat am I acting on" rather than "which chat am I permitted to act on." (The scheduler tools are the one exception: `dc_schedule*` require caller chat_id = target chat_id, because a job is owned by its chat.)

**Skip-permissions mode:** An agent can opt into "trusted" mode via `metadata['x-dc-skipPermissions']` on its definition (exposed as a checkbox in the agent-setup WebXDC card, and via `getSkipPermissions` / `setSkipPermissions` in `agents.ts`). When a subagent bound to such an agent triggers the PreToolUse hook, the dispatcher short-circuits in `plugin/dispatcher/skip-permissions.ts` — it auto-approves the verdict and writes a `skip_auto` entry to the permission event log instead of showing the WebXDC permission card.

**Scheduled jobs (v0.10+):** Subagents can create recurring or one-shot prompts via `dc_schedule` / `dc_schedule_list` / `dc_schedule_delete`. Jobs persist in `~/.claude/channels/deltachat/schedules/<chatId>-<jobId>.json` and are owned by the dispatcher's in-process scheduler — they survive subagent eviction, idle timeout, and crash. When a job fires the dispatcher cold-spawns (or reuses) the subagent for that chat and sends a synthetic user turn. Missed fires during dispatcher downtime are silently skipped (not caught up); past-due one-shots are reaped at startup with a log line. A soft warning is returned when a new schedule would fire more than 30 times in the next 7 days; there are no hard caps on job count or interval. The scheduler is deterministic TypeScript — it consumes zero model tokens on its own; tokens are only spent when a fire delivers a synthetic turn to the chat's bound agent.

**Schedule export/import (v1.2.2+, #67):** Schedules round-trip via `.schedules.yaml`. `/export-schedules` (or `/export-schedule`) typed in any paired chat triggers the dispatcher to emit a `chat-<id>.schedules.yaml` attachment containing that chat's recurring schedules. Drop a `.schedules.yaml` (or `.schedules.yml`) attachment into any paired chat to import — symmetric to the existing agent-YAML and `.familiar.yaml` import flows. Both directions are dispatcher-only — zero token cost (no MCP tool, no subagent involvement). One-shots are filtered from exports by default (their date-specific `targetMs` rarely transports cleanly between machines); recurring-only is the default. Fresh `jobId`s on import; no dedup against existing schedules; expired one-shots silently skipped. Schema + helpers in `plugin/schedule-import-export.ts`.

**Shared memory:** The auto-memory system (`~/.claude/projects/<cwd-hash>/memory/`) is filesystem-based and scoped to the working directory. Because the dispatcher and all subagents run on the same host with the same working directory, they share the same memory path — there is no per-agent or per-chat memory isolation. Any subagent can read and write the shared `MEMORY.md` index and individual memory files. This is intentional: it allows a subagent to persist facts (user preferences, project context, reference links) that are available to all future sessions regardless of which chat spawned them. Be aware that memory written by one agent is visible to all others.

**Tool-call event log (v1.1.1+):** Every DC tool invocation — from a subagent or the terminal Claude session — appends one JSONL line to `~/.claude/channels/deltachat/events/tools-<YYYY-MM-DD>.log`. Fields: `ts`, `source` (`subagent`/`terminal`), `tool`, `callerChatId`, `callerContactId`, `argChatId`, `targetOwner`, `durationMs`, `ok`, `errorCode`, `argPreview` (with `text`/`content`/`body`/`secret`/`password`/`token`/`email` redacted), `turnId` (subagent calls only; null when the call arrives outside an in-flight turn). Filenames roll over by UTC date; no in-process rotation, no retention policy — users can `rm` old files at will. Overridable via `DC_EVENT_DIR`. Useful for `jq` queries, test assertions, and informing the eventual `access.ts` split. Observability is best-effort: a write failure drops the event with a debug-log warning and never affects tool execution.

**Subagent turn log (v1.1.1+):** Each subagent turn (one round-trip through `SubagentCache.dispatch`) appends one JSONL line to `events/turns-<YYYY-MM-DD>.log`. Fields: `ts`, `turnId`, `chatId`, `agentId`, `sessionId`, `spawnColdMs` (attributed to the first turn after a cold spawn; 0 for cache-hit turns), `durationMs`, `toolCalls`, `exitReason`. `exitReason` is one of `completed` | `idle` | `lru_evict` | `turn_timeout` | `crash` | `user_abort` | `resume_fallback`. The `turnId` field cross-references tool-call events so `jq 'select(.turnId=="<id>")'` returns the tool sequence a turn issued. Same write discipline as the tool-call log.

**Permission decision log (v1.1.1+):** Every permission verdict — whether the owner tapped Allow/Deny in the WebXDC card or the dispatcher auto-approved under skip-permissions mode — appends one JSONL line to `events/permissions-<YYYY-MM-DD>.log`. Fields: `ts`, `chatId`, `agentId`, `tool`, `inputPreview` (same redaction rules as `argPreview`), `verdict` (`allow` | `deny`), `reason` (`user_allow` | `user_deny` | `skip_auto`), `timedOut` (reserved; always false for now — the subagent shell applies the hook timeout), `durationMs` (prompt arrival → verdict; 0 for `skip_auto`). This stream replaces the per-chat markdown audit files that skip-permissions used to write, and is the single source of truth for "what did the agent ask for and how was it answered?" review. Same write discipline as the other event streams.

**WebXDC update trace (v1.1.1+):** Every inbound WebXDC status update that survives permission-response interception is logged to `events/webxdc-<YYYY-MM-DD>.log` after owner verification runs — one line per update. Fields: `ts`, `msgId`, `chatId`, `appId`, `ownerVerified` (false for group-chat updates from non-owners that the owner-filter dropped), `payloadType` (the `payload.type` string convention used by dc-claude-channel apps; null when absent), `payloadSize` (serialized payload byte length). Payload contents are intentionally omitted — too large, and shapes are app-specific. Useful for debugging owner-verification misses and spotting runaway apps hammering the update stream. Same write discipline as the other event streams.

**`dc_show_events` tool (v1.1.1+):** A subagent (or the terminal session) can surface the event log back to the user via `dc_show_events`. Args: `chat_id`, optional `stream` (`tools` | `turns` | `permissions` | `webxdc` | `all`; default `all`), optional `since` (ISO-8601 timestamp or `<N>h` / `<N>d` relative offset; default `24h`), optional `tool` (tools-stream filter), optional `only_errors` (keep only tool failures / permission denies / unverified webxdc / turn crash/timeout/resume-fallback). Matches are read from `$DC_EVENT_DIR`, filtered, sorted, capped at 500 (most-recent kept), and delivered via `dc_send_file` as a markdown document with one fenced `jsonl` block per stream — scroll and long-press to comment on specific events. Query logic lives in `plugin/events-query.ts`; the tool handler lives in `plugin/server.ts` next to the other core tools.

Config (environment variables):

- `DC_SUBAGENT_MAX_ACTIVE` — cache size (default 8, range 1-16)
- `DC_SUBAGENT_IDLE_TIMEOUT_MIN` — idle timeout (default 15)
- `DC_HOOK_TIMEOUT_SEC` — max wait for a permission verdict (default 300)
- `DC_EVENT_DIR` — override for the event log dir (default `$DC_STATE_DIR/events/`)

## Subagent session resume

Each binding holds a persistent claude session UUID. The first spawn for a chat creates a fresh UUID and passes `--session-id <uuid>`; every subsequent (re)spawn — after idle timeout, LRU eviction, or crash — passes `--resume <uuid>` so claude rehydrates the prior in-process turn history (TodoWrites, plans, tool outputs). The session UUID is cleared (and a fresh one generated on next spawn) in the resume-fallback path if claude refuses to resume a stale id. The whole binding is deleted on unpair in `cleanupChat`. Phase-1 spikes showed `--resume` adds ~10 s on respawn vs ~6 s cold; respawns are rare so we accept the cost in exchange for not losing assistant-side context that `dc_chat_history` can't recover.

## Session resume / terminal teleport (v1.1+)

Subagents and local terminal `claude` sessions share the same on-disk `.jsonl` format, so either side can resume the other by UUID. The `dc_resume_in_terminal` tool emits a `cd … && claude --resume <uuid>` command (DC → terminal). The agent-setup card's "Resume a conversation" pane — reached from the home screen of the agent settings app — lets the user pick a recent session from the last 5 days (terminal-origin or orphan DC-origin, as long as it isn't currently bound) and attach it to a new DC chat (terminal → DC). Implementation in `plugin/resume.ts`. Same-machine only; no Anthropic round-trip. Historically called "teleport" — the model still recognizes that word and routes it here.

**Per-chat working directory.** Each binding records a `workingDir` field that is both the cwd the subagent spawns in and the cwd used when emitting a `cd … && claude --resume` command. Terminal-origin sessions keep the project dir they came from; DC-native chats adopt the dispatcher's `process.cwd()` at first spawn and persist it for stability across dispatcher restarts. Because claude resolves `--resume <uuid>` against `<projects-root>/<cwd-hash>/<uuid>.jsonl`, having a single consistent cwd per chat means there is one on-disk `.jsonl` per session — terminal and DC read/write the same file, and no copy/sync is needed when moving a session between the two. The single-writer constraint still applies (don't `--resume` from two terminals at once); the picker's `fuser`-based "live" indicator flags sessions currently held open.

**DC → terminal (resume-out).** The agent-setup card also has a "Send to terminal" screen: pick a DC chat, confirm, and the card emits the `cd … && claude --resume <uuid>` command for that session, migrates scheduled jobs to their new owner via `scheduleStore.moveForChat`, and tears down the DC chat via the shared `cleanupChat` helper (so scheduled jobs can't leak). The terminal then resumes the exact same `.jsonl` file the DC subagent was writing to. Implementation in `plugin/cleanup.ts` + `plugin/apps/agent-setup-app.ts`.

**Persistent session index.** A separate `~/.claude/channels/deltachat/session-agents/<sessionId>.json` index records which agent a session was last attached to, so a resumed session can re-adopt its original identity even after the binding is gone. Managed by `plugin/session-agents.ts`.

## Familiar Runtime (v1.0+)

The **Familiar runtime** lets subagents build custom WebXDC apps on the fly with Claude acting as a live backend. Two app types:

- **Static apps** — self-contained HTML, sent via `dc_send_webxdc`. No server component.
- **Familiar apps** — WebXDC apps with a Claude backend, created via `dc_familiar_create`. The subagent provides HTML (the client UI) and a JavaScript handler function (server-side logic). The handler runs in an eval sandbox with access to `ctx.state`, `ctx.sendUpdate()`, and `ctx.requestLLM()` — no fs/net/process access.

Familiar apps can be ephemeral (lost on restart) or persistent (state + handler saved to `~/.claude/channels/deltachat/familiars/`). Persistent apps are reloaded on dispatcher startup.

**Import:** Send a `.familiar.yaml` file as an attachment in any paired chat. The dispatcher intercepts it, validates the YAML (required fields: `name`, `html`, `handler`), and creates the Familiar app. Invalid YAML is rejected with an error.

**Tools:** `dc_familiar_create`, `dc_familiar_update`, `dc_familiar_list`, `dc_familiar_delete`.

## Agent badges (v1.0.2+)

Each agent's avatar is composed at render time from (1) a vendored Lucide line glyph and (2) an archetype-keyed colour palette, cached as PNG at `~/.claude/channels/deltachat/agent-badges/`.

- **Archetype** — every agent carries a `x-dc-archetype` metadata key (`role` / `utility` / `project`) that picks a curated glyph palette and accent colour. Unset defaults to `role`. See `ARCHETYPE_META_KEY` + `ARCHETYPE_PALETTES` in `plugin/agents.ts`.
- **Explicit glyph override** — `x-dc-glyph` can pin a specific glyph from the archetype's curated palette. Glyphs outside the palette are ignored (renderer falls back to the archetype default).
- **Cache key** — glyph + palette + orientation. Safe to blow away at any time; the next `setAgentIcon` call will re-render.
- **Manual wipe after 1.0.2 upgrade** — `rm -rf ~/.claude/channels/deltachat/agent-badges/` so existing agents re-render under the new palette (Haiku green, Sonnet amber, Opus orange; Slate family removed).

Files: `plugin/agent-icon-render.ts`, `plugin/agent-setup-glyphs.ts` (vendored SVGs + palette config), `plugin/agents.ts` (metadata helpers).

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
