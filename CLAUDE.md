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
  "createdAt": "2026-04-09T12:34:56.000Z"
}
```

## Development

```bash
cd plugin && bun install && bun test
```

## Testing the channel (research preview)

### Primary path — marketplace install (for end users and release testing)

```
/plugin marketplace add jhayashi/dc-claude-channel
/plugin install deltachat@dc-claude-channel
```

```bash
claude --dangerously-load-development-channels plugin:deltachat@dc-claude-channel
```

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
  - `file-reviewer-app.ts` — File reviewer: rendered markdown + syntax-highlighted source + inline commenting (1 tool, event-driven updates)
  - `permissions-app.ts` — Permission prompt via WebXDC (notification handler + polling). Phase 2: requires explicit `chat_id` on every request.
  - `agent-setup-app.ts` — Agent setup card: pick an existing agent or create a new one; creates the DC chat + persists agent + binding on confirm.
- `plugin/agents.ts` — Agent definition registry (YAML, reusable, matches Claude Managed Agents schema)
- `plugin/bindings.ts` — Per-chat binding records (chat ↔ agent link + session UUID + inheritClaudeMd)
- `plugin/agent-setup.ts` — XDC builder for the agent setup WebXDC app
- `plugin/dc-client.ts` — Wraps `@deltachat/jsonrpc-client` + `@deltachat/stdio-rpc-server`
- `plugin/access.ts` — File-based allowlist + pairing codes (~/.claude/channels/deltachat/approved/)
- `plugin/tutorial.ts` — Onboarding tutorial state machine
- `plugin/webxdc-filter.ts` — Centralized owner verification for WebXDC updates
- State dir: `~/.claude/channels/deltachat/` (.env, dc-data/, approved/, agents/, bindings/, schedules/, dispatcher.sock, debug.log)

## Subagent model (v0.9+)

Every paired chat that recently sent a message has a persistent `claude -p` subagent process handling it. Subagents are kept alive in an LRU cache bounded by `DC_SUBAGENT_MAX_ACTIVE` (default 8) so the common case — a small number of active chats — gets sub-second turnaround after the first cold spawn (~6 s). Idle subagents self-exit after `DC_SUBAGENT_IDLE_TIMEOUT_MIN` (default 15 minutes). The dispatcher's own MCP server stays running for the user's terminal Claude Code session — only per-chat messaging is rerouted through subagents.

Subagents run with `--permission-mode default` and the built-in CWD sandbox. When Claude wants to run a tool like Bash or Edit, a PreToolUse hook fires, connects to the dispatcher's Unix socket, and blocks waiting for a verdict. The dispatcher forwards the prompt to the existing permissions-app WebXDC flow in the bound chat and writes the user's Allow/Deny back to the hook. This preserves the v0.8.3 permission UX exactly while adding per-chat targeting (no `lastActiveChatId` TOCTOU).

DC tool calls (`dc_send`, `dc_send_file`, `dc_chat_history`, etc.) from a subagent flow through a tools-proxy MCP server loaded in that subagent, over the same Unix socket. The dispatcher enforces `chat_id` authorization at the socket boundary — a subagent bound to chat A cannot call DC tools against chat B.

**Skip-permissions mode:** An agent can opt into "trusted" mode via `metadata['x-dc-skipPermissions']` on its definition (exposed as a checkbox in the agent-setup WebXDC card, and via `getSkipPermissions` / `setSkipPermissions` in `agents.ts`). When a subagent bound to such an agent triggers the PreToolUse hook, the dispatcher short-circuits in `plugin/dispatcher/skip-permissions.ts` — it auto-approves the verdict and appends an entry to `~/.claude/channels/deltachat/audit/<chatId>.md` instead of showing the WebXDC permission card. The `dc_show_audit` core tool lets the subagent send the audit file back to the user via the file reviewer when asked (e.g. "what did you run?"). Audit files are append-only; there is no rotation.

**Scheduled jobs (v0.10+):** Subagents can create recurring or one-shot prompts via `dc_schedule` / `dc_schedule_list` / `dc_schedule_delete`. Jobs persist in `~/.claude/channels/deltachat/schedules/<chatId>-<jobId>.json` and are owned by the dispatcher's in-process scheduler — they survive subagent eviction, idle timeout, and crash. When a job fires the dispatcher cold-spawns (or reuses) the subagent for that chat and sends a synthetic user turn. Missed fires during dispatcher downtime are silently skipped (not caught up); past-due one-shots are reaped at startup with a log line. A soft warning is returned when a new schedule would fire more than 30 times in the next 7 days; there are no hard caps on job count or interval. The scheduler is deterministic TypeScript — it consumes zero model tokens on its own; tokens are only spent when a fire delivers a synthetic turn to the chat's bound agent.

Config:
- `DC_SUBAGENT_MAX_ACTIVE` — cache size (default 8, range 1-16)
- `DC_SUBAGENT_IDLE_TIMEOUT_MIN` — idle timeout (default 15)
- `DC_HOOK_TIMEOUT_SEC` — max wait for a permission verdict (default 300)

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
