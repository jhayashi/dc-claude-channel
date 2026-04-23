# dc-claude-channel

Delta Chat channel plugin for Claude Code (TypeScript/Bun). Matches the official Telegram/Discord plugin architecture.

## Agent model (v0.10+)

An "agent chat" is a DC chat bound to a reusable **agent definition** (name,
model, system prompt, tools) via a per-chat **binding** record that also holds
the claude session UUID used for `--resume`.

Three concerns, three storage locations:

- **Agent definitions** — portable YAML files in
  `~/.claude/channels/deltachat/agents/<agentId>.yaml`. Schema matches
  Claude Managed Agents (`name`, `model`, `system`, `tools`) with
  `x-dc-createdAt` for the creation timestamp. Reusable across chats — one
  definition may be bound to many DC chats at once. Managed by
  `plugin/agents.ts`.
- **Bindings** — host-local JSON files in
  `~/.claude/channels/deltachat/bindings/<chatId>.json`. Each record
  links a chat to an agent and holds runtime state: `agentId`,
  `sessionId` (for `--resume`), `inheritClaudeMd` flag, `createdAt`.
  Deleted on unpair; agent definitions are NOT deleted because they're
  reusable. Managed by `plugin/bindings.ts`.
- **Subagent processes** — ephemeral `claude -p` children in an LRU
  cache, spawned on demand. See "Subagent model" below.

`inheritClaudeMd` lives on the **binding**, not the agent, because it's a
host-local/environment concern (whether to include the dispatcher's
`CLAUDE.md` in the spawn) — an exported agent YAML should not carry
host-specific assumptions.

Editing an agent definition **mutates in place**: changes apply on the
next turn in every chat bound to that agent. The resumed claude session
keeps its prior history, so the next turn runs under the new prompt but
"remembers" things said under the old one. Usually fine; if you want a
clean slate, start a new chat.

**Import/export (v0.10+):** Agent definitions can be exported as `.yaml`
files via the agent-setup WebXDC card ("Export" button) and imported by
sending a `.yaml` file attachment into any paired DC chat. The dispatcher
intercepts `.yaml` attachments before the subagent sees them: valid
definitions are saved (with automatic ID collision resolution via `-2`,
`-3`, etc. suffixes); invalid YAML is rejected with an error message and
the attachment is forwarded to the subagent. Export sends the full agent
definition including `x-dc-*` metadata. Bindings (host-local chat
mappings) are not exported — the user creates a new chat via the
agent-setup card after importing. Round-trip compatible with Claude
Managed Agents API YAML format.

**Templates + archetypes (v1.0.2+):** agent creation opens on a template
gallery (Scheduler, News Briefing, Personal Assistant, …). Each template
seeds the system prompt, recommended model tier, and default tool
allowlist. Every agent also carries the `x-dc-archetype` metadata field
(`role` / `utility` / `project`) that drives its runtime badge palette —
see "Agent badges" below. Library lives in `plugin/templates.ts`.

**Per-agent tool access (v0.10+):** Each agent definition can restrict
which built-in tools and MCP servers its subagent is allowed to use via
two optional fields: `allowedBuiltinTools` (string array or null) and
`allowedMcpServers` (string array or null). `null` or absent means "all
tools/servers allowed" (the default for new agents); `[]` means "none."
Each `allowedMcpServers` entry is a server prefix (e.g., `dc`,
`claude_ai_Gmail`, `plugin_telegram_telegram`). Built-in tools have
fine-grained per-tool control; MCP servers are all-or-nothing toggles.
Restrictions are enforced at spawn time via `--allowedTools` CLI flag
with `mcp__<prefix>` entries for each enabled server.
The agent-setup WebXDC card includes a collapsible tool picker: per-tool
checkboxes for built-in tools, per-server toggles for MCP servers.
Changes take effect on next subagent spawn (idle timeout or restart).

**Forward compat:** the `tools: []` field is written on every agent as
a no-op hook. Per-agent tool capability restrictions use the separate
`allowedBuiltinTools` and `allowedMcpServers` fields instead.

## Agent badges (v1.0.2+)

Each agent's avatar is composed at render time from (1) a vendored
Lucide line glyph and (2) an archetype-keyed colour palette, cached as
PNG at `~/.claude/channels/deltachat/agent-badges/`.

- **Archetype** — every agent carries a `x-dc-archetype` metadata key
  (`role` / `utility` / `project`) that picks a curated glyph palette
  and accent colour. Unset defaults to `role`. See `ARCHETYPE_META_KEY`
  + `ARCHETYPE_PALETTES` in `plugin/agents.ts`.
- **Explicit glyph override** — `x-dc-glyph` can pin a specific glyph
  from the archetype's curated palette. Glyphs outside the palette are
  ignored (renderer falls back to the archetype default).
- **Cache key** — glyph + palette + orientation. Safe to blow away at
  any time; the next `setAgentIcon` call will re-render.
- **Manual wipe after 1.0.2 upgrade** —
  `rm -rf ~/.claude/channels/deltachat/agent-badges/` so existing
  agents re-render under the new palette (Haiku green, Sonnet amber,
  Opus orange; Slate family removed).

Files: `plugin/agent-icon-render.ts`, `plugin/agent-setup-glyphs.ts`
(vendored SVGs + palette config), `plugin/agents.ts` (metadata
helpers).

## Familiar Runtime (v1.0+)

The **Familiar runtime** lets subagents build custom WebXDC apps on the fly
with Claude acting as a live backend. Two app types:

- **Static apps** — self-contained HTML, sent via `dc_send_webxdc`. No
  server component.
- **Familiar apps** — WebXDC apps with a Claude backend, created via
  `dc_familiar_create`. The subagent provides HTML (the client UI) and a
  JavaScript handler function (server-side logic). The handler runs in an
  eval sandbox with access to `ctx.state`, `ctx.sendUpdate()`, and
  `ctx.requestLLM()` — no fs/net/process access.

Familiar apps can be ephemeral (lost on restart) or persistent (state +
handler saved to `~/.claude/channels/deltachat/familiars/`). Persistent
apps are reloaded on dispatcher startup.

**Import:** Send a `.familiar.yaml` file as an attachment in any paired
chat. The dispatcher intercepts it, validates the YAML (required fields:
`name`, `html`, `handler`), and creates the Familiar app. Invalid YAML is
rejected with an error.

**Tools:** `dc_familiar_create`, `dc_familiar_update`, `dc_familiar_list`,
`dc_familiar_delete`.

## Subagent session resume

Each binding holds a persistent claude session UUID. The first spawn for a
chat creates a fresh UUID and passes `--session-id <uuid>`; every subsequent
(re)spawn — after idle timeout, LRU eviction, or crash — passes
`--resume <uuid>` so claude rehydrates the prior in-process turn history
(TodoWrites, plans, tool outputs). The session UUID is cleared (and a fresh
one generated on next spawn) in the resume-fallback path if claude refuses to
resume a stale id. The whole binding is deleted on unpair in `cleanupChat`.
Phase-1 spikes showed `--resume` adds ~10 s on respawn vs ~6 s cold; respawns
are rare so we accept the cost in exchange for not losing assistant-side
context that `dc_chat_history` can't recover.

## Session resume (v1.1+)

Subagents and local terminal `claude` sessions share the same on-disk `.jsonl`
format, so either side can resume the other by UUID. The `dc_resume_in_terminal`
tool emits a `cd … && claude --resume <uuid>` command (DC → terminal). The
agent-setup card's "Resume a conversation" pane — reached from the home
screen of the agent settings app — lets the user pick a recent session
from the last 5 days (terminal-origin or orphan DC-origin, as long as it
isn't currently bound) and attach it to a new DC chat (terminal → DC).
Implementation in `plugin/resume.ts`. Same-machine only; no Anthropic
round-trip. Historically called "teleport" — the model still recognizes
that word and routes it here.

**Per-chat working directory.** Each binding records a `workingDir` field
that is both the cwd the subagent spawns in and the cwd used when emitting
a `cd … && claude --resume` command. Terminal-origin sessions keep the
project dir they came from; DC-native chats adopt the dispatcher's
`process.cwd()` at first spawn and persist it for stability across
dispatcher restarts. Because claude resolves `--resume <uuid>` against
`<projects-root>/<cwd-hash>/<uuid>.jsonl`, having a single consistent cwd
per chat means there is one on-disk `.jsonl` per session — terminal and
DC read/write the same file, and no copy/sync is needed when moving a
session between the two. The single-writer constraint still applies
(don't `--resume` from two terminals at once); the picker's `fuser`-based
"live" indicator flags sessions currently held open.

**DC → terminal (resume-out).** The agent-setup card also has a "Send
to terminal" screen: pick a DC chat, confirm, and the card emits the
`cd … && claude --resume <uuid>` command for that session, migrates
scheduled jobs to their new owner via `scheduleStore.moveForChat`, and
tears down the DC chat via the shared `cleanupChat` helper (so scheduled
jobs can't leak). The terminal then resumes the exact same `.jsonl`
file the DC subagent was writing to. Implementation in
`plugin/cleanup.ts` + `plugin/apps/agent-setup-app.ts`.

**Persistent session index.** A separate
`~/.claude/channels/deltachat/session-agents/<sessionId>.json` index
records which agent a session was last attached to, so a resumed
session can re-adopt its original identity even after the binding is
gone. Managed by `plugin/session-agents.ts`.

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

## Development

```bash
cd plugin && bun install && bun test
```

## Testing the channel (research preview)

### Primary path — marketplace install (for end users and release testing)

Single Claude Code launch, then install + reload in-session:

```bash
claude --dangerously-load-development-channels plugin:deltachat@dc-claude-channel
```

```
/plugin marketplace add jhayashi/dc-claude-channel
/plugin install deltachat@dc-claude-channel
/plugin reload-plugins
```

`/plugin reload-plugins` activates the newly installed plugin in the current session — no restart needed. On first install the dispatcher forks `bun install` in the background (~30–120s); DC tool calls issued during that window transparently block on the readiness gate rather than crashing on missing native modules. The SessionStart hook does not surface install state — the banner was noisy and the readiness gate makes it unnecessary.

Testing against a local unpushed change: use `/plugin marketplace add /path/to/dc-claude-channel` (absolute local path) instead of the GitHub slug. Relative-path plugin sources resolve against the marketplace root (the repo root), so `./plugin` finds the right place.

### Dev path — in-place editing (for active development)

```bash
claude --plugin-dir /path/to/dc-claude-channel/plugin --dangerously-load-development-channels plugin:deltachat@inline
```

Use this when iterating on `server.ts` or other source files and you want edits to take effect without running `/plugin marketplace update`.

Prerequisites for the dev path:
- `~/.claude/plugins/installed_plugins.json` must have `"deltachat@inline"` entry — add it manually or use the marketplace install path (recommended) instead
- Do NOT add to `enabledPlugins` in settings.json (causes account lock contention)
- No project-level `.mcp.json` defining deltachat (creates duplicate server)
- `--plugin-dir` registers plugins with marketplace name `inline` internally
- Plugin must be in `installed_plugins.json` (as `deltachat@inline`) for the channel flag to accept it
- `/mcp` should show `plugin:deltachat:deltachat` not plain `deltachat` under Project MCPs
- Never run Claude Code from inside this repo — the project-level `plugin/.mcp.json` conflicts with the plugin-installed server

## Voice transcription (v1.0+)

Voice messages (.m4a) are transcribed locally via `@napi-rs/whisper`
(prebuilt native bindings to whisper.cpp) before reaching the subagent.
No system dependencies required — no cmake, no g++, no ffmpeg. Just
`bun install` and it works.

The dispatcher intercepts voice messages in `runSubagentTurn`, decodes
audio natively via Symphonia (`decodeAudio()`), runs whisper inference
in-process, and prepends `[Voice transcript]: <text>` to the message
text. The subagent sees a normal text message with `source=voice`
metadata.

Config (environment variables):
- `DC_STT_ENABLED` — `true` (default) or `false`
- `DC_STT_MODEL` — ggml model name (default `base.en`). Models are
  auto-downloaded from Hugging Face on first use to `$DC_STATE_DIR/whisper-models/`.
- `DC_STT_ECHO` — `quoted` (default, echoes transcript back to chat) or `silent`
- `DC_STT_TIMEOUT_SEC` — max transcription runtime (default `120`)
- `DC_STT_MAX_DURATION_SEC` — max audio length to attempt (default `300`)

Files:
- `plugin/stt.ts` — Core transcription module (config, model download,
  native audio decoding, transcription via @napi-rs/whisper)
- `plugin/test/stt.test.ts` — Unit tests for config parsing, voice detection

## Visual communication via WebXDC

When the conversation calls for visual output — UI mockups, design
comparisons, diagrams, data visualizations — build a self-contained HTML
app and send it via `dc_send_webxdc`. A throwaway `.xdc` renders properly
on any device and stays accessible from the DC app list. Don't describe
visuals in markdown when you can show them.

**Naming:** Use a clear, descriptive manifest name with a version so the
user can track iterations in the app list. For example:
`name = "Agent Settings Mockup v2"` not `name = "mockup"`. Bump the
version each time you send an updated revision.

## Key Gotchas

- `deltachat-rpc-server` uses file locking — only one process per account database. Multiple sessions = lock contention.
- WebXDC status updates must wrap data as `{payload: {...}}` — the applet receives `update.payload`.
- WebXDC icons must be square — Delta Chat crops non-square to a square thumbnail.
- Channel permission protocol only supports `allow`/`deny` — no "always allow" option.
- Plugin source lives in `plugin/` subdirectory (not repo root) to prevent `.mcp.json` from being auto-loaded as a project MCP.
- **Version bump required:** When modifying `permission-prompt.html`, bump `APP_VERSION` in the HTML (e.g., 1.00 → 1.01). The builder reads the HTML fresh from disk and parses the version automatically — no need to update `permissions.ts`. Old apps auto-upgrade by detecting version mismatch. No server restart needed.

## Architecture

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
- `plugin/access/` — File-based allowlist + pairing codes (~/.claude/channels/deltachat/approved/). Split (v1.1.2+) into `chat-allowlist.ts` (persistent `approved/<chatId>` store), `pairing.ts` (in-memory arm window + pending codes), `principals.ts` (Phase-0 skeleton for the upcoming identity/teams model), and `index.ts` (the barrel every call site imports).
- `plugin/tutorial.ts` — Onboarding tutorial state machine
- `plugin/webxdc-filter.ts` — Centralized owner verification for WebXDC updates
- `plugin/events.ts` — Structured JSONL log of every DC tool call
- `plugin/test/webxdc/` — Tier-1 WebXDC test harness (opt-in; Playwright-based). Isolated `package.json` so marketplace installs pay zero cost. See `plugin/test/webxdc/README.md` for contributor bootstrap.
- State dir: `~/.claude/channels/deltachat/` (.env, dc-data/, approved/, agents/, bindings/, schedules/, events/, dispatcher.sock, debug.log)

## Subagent model (v0.9+)

Every paired chat that recently sent a message has a persistent `claude -p` subagent process handling it. Subagents are kept alive in an LRU cache bounded by `DC_SUBAGENT_MAX_ACTIVE` (default 8) so the common case — a small number of active chats — gets sub-second turnaround after the first cold spawn (~6 s). Idle subagents self-exit after `DC_SUBAGENT_IDLE_TIMEOUT_MIN` (default 15 minutes). The dispatcher's own MCP server stays running for the user's terminal Claude Code session — only per-chat messaging is rerouted through subagents.

Subagents run with `--permission-mode default` and the built-in CWD sandbox. When Claude wants to run a tool like Bash or Edit, a PreToolUse hook fires, connects to the dispatcher's Unix socket, and blocks waiting for a verdict. The dispatcher forwards the prompt to the existing permissions-app WebXDC flow in the bound chat and writes the user's Allow/Deny back to the hook. This preserves the v0.8.3 permission UX exactly while adding per-chat targeting (no `lastActiveChatId` TOCTOU).

DC tool calls (`dc_send`, `dc_send_file`, `dc_chat_history`, etc.) from a subagent flow through a tools-proxy MCP server loaded in that subagent, over the same Unix socket. Tool calls are gated by the owner's global paired-chats allowlist — a subagent can read or post into any chat the owner has paired, not just its own. Chat-scoping is **not a privacy/security boundary** between paired chats; it's a **context-hygiene default** — a subagent's own chat is the natural working context, but cross-chat reads (via `dc_chat_history`) or writes (via `dc_send_*`) are intentionally reachable when the agent needs to pull or push context across chats. Treat chat_id as "which chat am I acting on" rather than "which chat am I permitted to act on." (The scheduler tools are the one exception: `dc_schedule*` require caller chat_id = target chat_id, because a job is owned by its chat.)

**Skip-permissions mode:** An agent can opt into "trusted" mode via `metadata['x-dc-skipPermissions']` on its definition (exposed as a checkbox in the agent-setup WebXDC card, and via `getSkipPermissions` / `setSkipPermissions` in `agents.ts`). When a subagent bound to such an agent triggers the PreToolUse hook, the dispatcher short-circuits in `plugin/dispatcher/skip-permissions.ts` — it auto-approves the verdict and writes a `skip_auto` entry to the permission event log (see "Permission decision log" below) instead of showing the WebXDC permission card. Reviewing past auto-approvals is handled by the same event-log tooling that surfaces all permission decisions (no separate markdown audit file — that layer was retired in v1.1.1).

**Scheduled jobs (v0.10+):** Subagents can create recurring or one-shot prompts via `dc_schedule` / `dc_schedule_list` / `dc_schedule_delete`. Jobs persist in `~/.claude/channels/deltachat/schedules/<chatId>-<jobId>.json` and are owned by the dispatcher's in-process scheduler — they survive subagent eviction, idle timeout, and crash. When a job fires the dispatcher cold-spawns (or reuses) the subagent for that chat and sends a synthetic user turn. Missed fires during dispatcher downtime are silently skipped (not caught up); past-due one-shots are reaped at startup with a log line. A soft warning is returned when a new schedule would fire more than 30 times in the next 7 days; there are no hard caps on job count or interval. The scheduler is deterministic TypeScript — it consumes zero model tokens on its own; tokens are only spent when a fire delivers a synthetic turn to the chat's bound agent.

**Shared memory:** The auto-memory system (`~/.claude/projects/<cwd-hash>/memory/`) is filesystem-based and scoped to the working directory. Because the dispatcher and all subagents run on the same host with the same working directory, they share the same memory path — there is no per-agent or per-chat memory isolation. Any subagent can read and write the shared `MEMORY.md` index and individual memory files. This is intentional: it allows a subagent to persist facts (user preferences, project context, reference links) that are available to all future sessions regardless of which chat spawned them. Be aware that memory written by one agent is visible to all others.

**Tool-call event log (v1.1.1+):** Every DC tool invocation — from a subagent or the terminal Claude session — appends one JSONL line to `~/.claude/channels/deltachat/events/tools-<YYYY-MM-DD>.log`. Fields: `ts`, `source` (`subagent`/`terminal`), `tool`, `callerChatId`, `callerContactId`, `argChatId`, `targetOwner`, `durationMs`, `ok`, `errorCode`, `argPreview` (with `text`/`content`/`body`/`secret`/`password`/`token`/`email` redacted), `turnId` (subagent calls only; null when the call arrives outside an in-flight turn). Filenames roll over by UTC date; no in-process rotation, no retention policy — users can `rm` old files at will. Overridable via `DC_EVENT_DIR`. Useful for `jq` queries, test assertions, and informing the eventual `access.ts` split. Observability is best-effort: a write failure drops the event with a debug-log warning and never affects tool execution.

**Subagent turn log (v1.1.1+):** Each subagent turn (one round-trip through `SubagentCache.dispatch`) appends one JSONL line to `events/turns-<YYYY-MM-DD>.log`. Fields: `ts`, `turnId`, `chatId`, `agentId`, `sessionId`, `spawnColdMs` (attributed to the first turn after a cold spawn; 0 for cache-hit turns), `durationMs`, `toolCalls`, `exitReason`. `exitReason` is one of `completed` | `idle` | `lru_evict` | `turn_timeout` | `crash` | `user_abort` | `resume_fallback`. The `turnId` field cross-references tool-call events so `jq 'select(.turnId=="<id>")'` returns the tool sequence a turn issued. Same write discipline as the tool-call log.

**Permission decision log (v1.1.1+):** Every permission verdict — whether the owner tapped Allow/Deny in the WebXDC card or the dispatcher auto-approved under skip-permissions mode — appends one JSONL line to `events/permissions-<YYYY-MM-DD>.log`. Fields: `ts`, `chatId`, `agentId`, `tool`, `inputPreview` (same redaction rules as `argPreview`), `verdict` (`allow` | `deny`), `reason` (`user_allow` | `user_deny` | `skip_auto`), `timedOut` (reserved; always false for now — the subagent shell applies the hook timeout), `durationMs` (prompt arrival → verdict; 0 for `skip_auto`). This stream replaces the per-chat markdown audit files that skip-permissions used to write, and is the single source of truth for "what did the agent ask for and how was it answered?" review. Same write discipline as the other event streams.

**WebXDC update trace (v1.1.1+):** Every inbound WebXDC status update that survives permission-response interception is logged to `events/webxdc-<YYYY-MM-DD>.log` after owner verification runs — one line per update. Fields: `ts`, `msgId`, `chatId`, `appId`, `ownerVerified` (false for group-chat updates from non-owners that the owner-filter dropped), `payloadType` (the `payload.type` string convention used by dc-claude-channel apps; null when absent), `payloadSize` (serialized payload byte length). Payload contents are intentionally omitted — too large, and shapes are app-specific. Useful for debugging owner-verification misses and spotting runaway apps hammering the update stream. Same write discipline as the other event streams.

**`dc_show_events` tool (v1.1.1+):** A subagent (or the terminal session) can surface the event log back to the user via `dc_show_events`. Args: `chat_id`, optional `stream` (`tools` | `turns` | `permissions` | `webxdc` | `all`; default `all`), optional `since` (ISO-8601 timestamp or `<N>h` / `<N>d` relative offset; default `24h`), optional `tool` (tools-stream filter), optional `only_errors` (keep only tool failures / permission denies / unverified webxdc / turn crash/timeout/resume-fallback). Matches are read from `$DC_EVENT_DIR`, filtered, sorted, capped at 500 (most-recent kept), and delivered via `dc_send_file` as a markdown document with one fenced `jsonl` block per stream — scroll and long-press to comment on specific events. Query logic lives in `plugin/events-query.ts`; the tool handler lives in `plugin/server.ts` next to the other core tools.

Config:
- `DC_SUBAGENT_MAX_ACTIVE` — cache size (default 8, range 1-16)
- `DC_SUBAGENT_IDLE_TIMEOUT_MIN` — idle timeout (default 15)
- `DC_HOOK_TIMEOUT_SEC` — max wait for a permission verdict (default 300)
- `DC_EVENT_DIR` — override for the event log dir (default `$DC_STATE_DIR/events/`)

## Building a WebXDC App

To add a new WebXDC app to this channel plugin, create two files and add one import.

### 1. Create the WebXDC HTML app

Put your app HTML in `plugin/webxdc/your-app.html`. This is a self-contained HTML file that runs inside the WebXDC sandbox.

Key constraints:
- Include `<script src="webxdc.js"></script>` — the messenger injects this at runtime. Do NOT bundle a copy.
- All assets must be self-contained (no CDN imports, no `fetch()`, no external URLs).
- Use `window.webxdc.setUpdateListener(fn, 0)` to receive data from the server.
- Use `window.webxdc.sendUpdate({payload: {...}}, 'description')` to send data back.
- **Owner verification (REQUIRED):** Every `sendUpdate` payload MUST include `senderAddr: window.webxdc.selfAddr`. The server uses this to verify the update came from the chat owner. Updates without `senderAddr` are rejected in owned chats. A test enforces this — see `test/webxdc-sender-addr.test.ts`.
- Updates replay from serial 0 on every app open — your handler must be idempotent.
- Use `textContent` (not innerHTML) for user-supplied data to prevent XSS.
- `localStorage` is not reliably persistent across sessions. Use `sendUpdate` for durable state.

### 2. Create the XDC builder module

Create `plugin/your-app.ts` that reads the HTML at import time and exports a build function:

```typescript
import { readFileSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const APP_HTML = readFileSync(join(import.meta.dir, 'webxdc', 'your-app.html'))
const ICON_PNG = readFileSync(join(import.meta.dir, 'webxdc', 'your-app-icon.png'))
const MANIFEST_TOML = 'name = "Your App"\n'

export async function buildYourAppXDC(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'claude-dc-yourapp-'))
  const xdcPath = join(dir, 'your-app.xdc')
  const contentDir = join(dir, 'content')
  mkdirSync(contentDir)
  writeFileSync(join(contentDir, 'index.html'), APP_HTML)
  writeFileSync(join(contentDir, 'manifest.toml'), MANIFEST_TOML)
  writeFileSync(join(contentDir, 'icon.png'), ICON_PNG)
  const result = Bun.spawnSync([
    'zip', '-j', xdcPath,
    join(contentDir, 'index.html'),
    join(contentDir, 'manifest.toml'),
    join(contentDir, 'icon.png'),
  ])
  if (result.exitCode !== 0) throw new Error(`zip failed: ${result.stderr.toString()}`)
  return xdcPath
}
```

Icon must be square (128x128 to 512x512 px). Do NOT bundle `webxdc.js` in the ZIP.

### Pure-HTML apps (no server component)

If your app is one-way (no custom tools, no `onWebXDCUpdate` handler), you don't need steps 3-4. Just build the `.xdc` and send it with the core `dc_send_webxdc` tool. No registration in `apps.ts`, no server restart. This is the fastest path for prototyping — iterate on the HTML, rebuild the `.xdc`, and send it.

Steps 3-4 are only needed when your app requires server-side tools or needs to receive user responses via `onWebXDCUpdate`.

### 3. Create the app wrapper

Create `plugin/apps/your-app-app.ts` implementing the `WebXDCApp` interface:

```typescript
import type { WebXDCApp, ToolDef, ToolResult, AppContext } from '../webxdc-app.js'
import * as yourApp from '../your-app.js'

// Session tracking (reuse app per chat instead of sending a new one each time)
const sessions = new Map<number, { msgId: number; lastSerial: number }>()

export const yourAppApp: WebXDCApp = {
  id: 'your-app',

  // Optional: channel instructions appended to Claude's system prompt.
  // Use this to tell Claude when and how to use your app's tools.
  instructions: 'When the user asks for X, call dc_your_tool with ...',

  tools(): ToolDef[] {
    return [{
      name: 'dc_your_tool',
      description: 'Does something useful',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: { type: 'string', description: 'Chat ID' },
          data: { type: 'string', description: 'Data to send' },
        },
        required: ['chat_id', 'data'],
      },
    }]
  },

  async callTool(name: string, args: Record<string, unknown>, ctx: AppContext): Promise<ToolResult | null> {
    if (name !== 'dc_your_tool') return null

    const chatId = Number(args.chat_id as string)
    if (!chatId || !ctx.isAllowed(chatId)) {
      return { content: [{ type: 'text', text: 'invalid or unauthorized chat' }], isError: true }
    }

    // Build payload — always wrap in {payload: {...}}
    const update = JSON.stringify({ payload: { type: 'init', data: args.data } })

    let session = sessions.get(chatId)
    if (session) {
      // Reuse existing app
      await ctx.client.sendWebXDCUpdate(session.msgId, update)
    } else {
      // Send new app
      const xdcPath = await yourApp.buildYourAppXDC()
      const msgId = await ctx.client.sendWebXDC(chatId, xdcPath)
      await ctx.client.sendWebXDCUpdate(msgId, update)
      session = { msgId, lastSerial: 0 }
      sessions.set(chatId, session)
      // Clean up temp file
      const { unlinkSync } = await import('node:fs')
      try { unlinkSync(xdcPath) } catch {}
    }

    return { content: [{ type: 'text', text: 'App sent.' }] }
  },

  // Optional: handle user responses from the WebXDC app.
  // Updates are pre-filtered by server.ts — only owner-verified updates arrive here.
  // Do NOT call getWebXDCUpdates yourself; use the provided updates array.
  async onWebXDCUpdate(msgId: number, updates: WebXDCUpdate[], ctx: AppContext): Promise<void> {
    for (const u of updates) {
      const payload = u.payload as { type?: string } | null
      if (!payload) continue
      ctx.logf('your-app: got update type=%s for msg %d', payload.type, msgId)
    }
  },

  // Optional: register MCP notification handlers (rare — only for system events).
  // registerNotifications?(ctx: AppContext): void { ... }

  // Optional: run on startup (e.g., start a scheduler).
  // start?(ctx: AppContext): void { ... }

  // Optional: cleanup on shutdown (e.g., clear intervals).
  // stop?(): void { ... }
}
```

### 4. Register in apps.ts

Add one import and one array entry to `plugin/apps.ts`:

```typescript
import { yourAppApp } from './apps/your-app-app.js'

export const apps: WebXDCApp[] = [
  markdownViewerApp,
  permissionsApp,
  emailTriageApp,
  yourAppApp,  // <-- add here
]
```

That's it. Server.ts handles tool registration, dispatch, polling, and shutdown automatically.

### AppContext reference

Your app receives an `AppContext` with:

| Field | Type | Use |
|-------|------|-----|
| `client` | `DCClient` | `sendWebXDC()`, `sendWebXDCUpdate()`, `send()` |
| `mcp` | `Server` | `mcp.notification()` for emitting channel events |
| `isAllowed` | `(chatId) => bool` | Check access before sending |
| `allowedChats` | `() => number[]` | All approved chat IDs |
| `logf` | `(fmt, ...args) => void` | Debug logging (`%s`, `%d`, `%v` placeholders) |
| `safeName` | `(s) => string` | Sanitize user strings for notification meta |
| `registerWebXDCMsg` | `(msgId, app, chatId) => void` | Register a WebXDC msgId for owner-verified update dispatch |
| `unregisterWebXDCMsg` | `(msgId) => void` | Unregister on session clear |
| `lastActiveChatId` | `() => number \| null` | Chat that most recently sent a message |

### WebXDCApp interface reference

| Method | Required | When called |
|--------|----------|-------------|
| `tools()` | Yes | Once at startup for tool registration |
| `callTool(name, args, ctx)` | Yes | On each MCP tool call (return `null` if not your tool) |
| `onWebXDCUpdate(msgId, updates, ctx)` | No | When owner-verified WebXDC updates arrive (pre-filtered by server.ts) |
| `registerNotifications(ctx)` | No | Once at startup for MCP notification handlers |
| `start(ctx)` | No | Once after MCP connect (schedulers, etc.) |
| `stop()` | No | On shutdown (clear intervals, release resources) |
| `instructions` | No | String appended to Claude's channel system prompt |

### Common patterns

**Reuse vs fresh app:** Reusing one WebXDC app per chat (via `sendWebXDCUpdate`) avoids cluttering the chat with duplicate app cards. But the user must scroll up to find it. Use `info`/`href` fields on updates to create tappable notification messages that open the app.

**Payload wrapping:** Always send `{payload: {...}}` — the app receives `update.payload`. Sending a bare object delivers `undefined`.

**Replay safety:** `setUpdateListener(fn, 0)` replays all updates from the beginning on every app open. Design handlers to reconstruct state from the full replay, not just append.

**Tool name collisions:** Prefix your tool names with `dc_` + your app name to avoid collisions.

**Owner verification (REQUIRED):** Every `sendUpdate` payload MUST include `senderAddr: window.webxdc.selfAddr`. The server reads all WebXDC updates centrally in `server.ts`, verifies `senderAddr` against the chat owner (from `access.getOwner()`), and only forwards owner-verified updates to apps via `onWebXDCUpdate()`. Updates without `senderAddr` or from non-owners are silently rejected. This prevents non-owners in group chats from triggering actions (approving permissions, submitting comments, etc.). A test (`test/webxdc-sender-addr.test.ts`) enforces that every HTML file includes `senderAddr` in all `sendUpdate` calls.

**App versioning and auto-upgrade (REQUIRED):** Once a `.xdc` is sent to a chat, its HTML is frozen — editing the source file has no effect on already-delivered apps. Without auto-upgrade, every HTML change requires the user to restart their terminal session. All WebXDC apps MUST implement the auto-upgrade protocol:
1. Include `var APP_VERSION = <number>` in the HTML (required by `xdc-builder.ts`)
2. Include `version` in every payload sent to the app (read via `getViewerVersion()` or equivalent)
3. In the HTML, check incoming payloads: if `payload.version > APP_VERSION`, send `{type: 'version_mismatch', senderAddr: window.webxdc.selfAddr}` back via `sendUpdate` and show a loading state
4. In your app's `onWebXDCUpdate()`, handle `version_mismatch`: unregister the old msgId, delete the session, rebuild and send a fresh `.xdc`, register the new msgId
5. When you change the HTML, bump `APP_VERSION` in the HTML file (e.g., 1.00 → 1.01) — the builder reads it automatically

This is essential for iterative development via Delta Chat — the user may be on their phone away from the terminal. See `plugin/apps/permissions-app.ts` and `plugin/apps/markdown-viewer-app.ts` for reference implementations.

### Pre-built XDCs at release time

Core server-coupled apps (`permission-prompt`, `file-reviewer`, `agent-setup`) ship pre-zipped in `plugin/webxdc-prebuilt/`. At runtime, `buildXDC` checks for `<basename>-v<version>.xdc` there before re-zipping. On a match, the cached file is served; on miss (version bumped, file missing) the live zip runs and the result still works.

Before cutting a release, run `bun run build:xdcs` in `plugin/` to regenerate the cache and commit the updated `.xdc` files. Expected size: ~180 KB across the three apps — binary diffs on every release are normal.

During local HTML iteration, set `DC_SKIP_PREBUILT=1` to bypass the cache without having to re-run the build script every edit.

### Pre-built agent badges at release time

Agent profile images are composed from a Lucide glyph + model-tier palette and rendered on demand via Resvg. The UI only exposes the three archetype-default glyphs (`role`→user-round, `utility`→cog, `project`→folder-kanban), so the reachable matrix is 3 archetypes × 3 model families × 2 trust states = 18 PNGs. Those ship pre-rendered in `plugin/agent-badges-prebuilt/`. At runtime, `renderAgentBadge` prefers the prebuilt (via `copyFileSync`) over running Resvg; non-default glyphs (a future glyph picker) fall through to the live renderer.

Before cutting a release, run `bun run build:badges` in `plugin/` (or `bun run build:prebuilt` to do XDCs + badges together). Expected size: ~240 KB across the 18 PNGs.

`DC_SKIP_PREBUILT=1` bypasses both XDC and badge caches — use during palette or glyph iteration.
