# Plan: Issue #1 — Subagent-per-channel-message architecture (v8)

Tracks https://github.com/jhayashi/dc-claude-channel/issues/1

> **v8 changelog (post-Spikes 1F/1G):** The permission story is
> settled. Spike 1E proved MCP servers cannot receive permission
> operations. Spike 1F proved stream-json only reports
> `permission_denials` *after* enforcement. Spike 1G proved
> **PreToolUse hooks fire synchronously in `claude -p` and can block
> on an external round-trip**, which is the piece we needed.
>
> The Phase 2 permission relay is now:
>
> 1. Each subagent launches with `--settings <generated-hook-config>`
>    pointing at a PreToolUse hook script bound to the subagent's
>    `chat_id` via an env var.
> 2. When Claude wants to run Bash/Edit/Write/WebFetch, the hook fires,
>    reads the tool input from stdin, opens the dispatcher's Unix
>    socket, sends `{kind: 'permissionRequest', chatId, tool, input}`,
>    and blocks reading the reply.
> 3. The dispatcher relays to the existing `permissions-app` WebXDC
>    flow in the bound chat. The user taps Allow/Deny in Delta Chat
>    exactly like today.
> 4. The dispatcher writes the verdict back to the hook socket. The
>    hook exits 0 (allow) or 2 with a stderr message (deny).
>
> This preserves the v0.8.3 UX exactly while gaining per-chat
> targeting, eliminates `lastActiveChatId` TOCTOU naturally (every
> permission prompt is bound to its originating subagent, and the
> subagent is bound to its chat at spawn time), and works inside `-p`.
>
> `permissionRequest` / `permissionResponse` return to the wire
> protocol — the v4 deletion was premature. They're no longer routed
> via the MCP tools proxy but via a dedicated hook-socket connection.
>
> **v7 changelog (post-Spike-1A prototype):** Real measurements from
> `claude -p` killed the spawn-per-message model:
>
> - Cold-start wall-clock: **~6 s** for a trivial prompt.
> - `--resume <uuid>` wall-clock: **~10 s** (actually slower than cold
>   because of context load).
> - RSS per idle subprocess: **~328 MB**.
> - CLI flags: the plan assumed `--session <id>`; actual flags are
>   `--session-id <uuid>` for the first call and `--resume <uuid>` for
>   follow-ups.
>
> Consequences:
>
> 1. **Spawn-per-message is dead.** 6-10 s every message is a bad UX
>    and wastes compute.
> 2. **Warm pool alone doesn't help.** Even "warm" resume is 10 s
>    because model + context load dominate, not process spawn.
> 3. **Persistent subagent processes replace both.** Dispatcher keeps a
>    bounded LRU cache of live `claude -p` processes, one per recently
>    active chat. Messages to a cached chat reuse the process (sub-
>    second because the model is already loaded and the context is in
>    RAM). Eviction when over cap; idle timeout to shrink when quiet.
> 4. **Phase 2.5 (warm pool)** is subsumed into Phase 2 as the LRU cache
>    model and deleted as a separate phase.
> 5. **Latency budgets removed.** Instead of hard budgets, the design
>    targets "cached chat = sub-second round-trip, first-ever message
>    for a chat = document 6-10 s cold-start + send an ack reply".
>
> **v6 changelog:** Spike 1A gains an explicit cold-start latency
> budget (< 1500 ms). New Phase 2.5 (warm subagent pool) added,
> conditional on Spike 1A.3 missing the budget. Targets the "fast first
> response in 1:1 chats" concern without giving up context isolation
> or parallelism.
>
> **v5 changelog:** Phase 0 dropped — broadcasting permission prompts
> to all paired chats was chat spam. The TOCTOU is fixed properly by
> Phase 2 via subagent → bound chat_id mapping. No standalone
> shippable; permission targeting rides with the full rewrite.
>
> **v4 changelog (post-v0.8.3):** Reframed for the auto-pair onboarding
> model that shipped in v0.8.3. The dispatcher no longer treats pairing
> as a per-chat handshake — once an owner is known, new chats they
> initiate are silently approved by the existing auto-pair branch in
> `server.ts`. SessionStart hook handles first-time onboarding. Message
> classification table updated: `ChatModified` (self-leave cleanup) and
> `normalizeSystemMessageType` (dc-core 'Unknown' default) already ship
> in v0.8.3, so the dispatcher inherits them for free. Phase 0 (TOCTOU
> fix on `lastActiveChatId`) is **still pending** — verified
> `lastActiveChatId` is still a module global in `plugin/server.ts`.
>
> **v3 changelog:** Subagents get **full tool access** (Bash/Edit/Read run
> locally inside the subagent — only DC-specific tools proxy back to the
> dispatcher because of the DC lock). The permission relay is fully
> specified end-to-end instead of cut. Model defaults inverted: dispatcher
> defaults to haiku (routing only), subagents default to sonnet/opus
> (reasoning over tool output).
>
> **v2 changelog:** Incorporates Alice Chen (frontend/WebXDC) and Oliver Chen
> (AI codegen failure modes) review feedback. Wire protocol schema written
> inline, escape hatches removed, additional spikes added, per-chat state
> replaces module globals.

## Terminology

To avoid drift across the plan:

- **Dispatcher** — the long-lived top-level Claude Code session that owns the
  DC RPC connection and spawns subagents.
- **Subagent** — a `claude -p` process spawned per incoming DC message,
  scoped to one chat.
- **Tools proxy** — the thin MCP server loaded inside a subagent that
  forwards tool calls over a Unix socket to the dispatcher.
- **Chat** — a Delta Chat chat (1:1 or group), identified by `chat_id`.
- **App instance** — a delivered WebXDC app (file reviewer, permission
  prompt) tracked by `msgId`.

## Current state and honest framing

The issue lists four motivations:

| # | Motivation | Fixable without subagents? |
|---|---|---|
| 1 | Permission targeting TOCTOU (lastActiveChatId races) | **Yes** — Phase 0 below |
| 2 | Blocking: slow tool call in one chat delays another | **No** — needs real parallelism |
| 3 | Context pollution across chats | **No** — needs separate context windows |
| 4 | Per-group model selection | **No** — needs separate model-configured sessions |

This plan keeps Phase 0 (cheap TOCTOU fix) as a **standalone shippable**
unit, then commits to the full rewrite for #2-4.

## Design: how subagents actually work here

### The lock problem

`deltachat-rpc-server` uses file-level locking on the account DB. Only one
process can hold the DC connection at a time. Subagents cannot each open
their own DC connection — they would deadlock.

### The split

1. **Dispatcher** — owns the single DC connection. Receives all incoming
   messages and WebXDC updates. Spawns subagents. Hosts a Unix socket that
   handles two things: (a) DC tool calls proxied from subagents, and
   (b) permission requests proxied from subagents. Defaults to **haiku**
   since its job is routing, not reasoning.
2. **Tools proxy** — minimal MCP server loaded by every subagent. Only
   DC-specific tools (`dc_send`, `dc_send_file`, `dc_chat_history`, etc.)
   are forwarded over the socket. Bash/Edit/Read/Grep/Glob and all other
   built-in Claude Code tools run **locally inside the subagent** with no
   proxying — that's where the parallelism wins come from. The proxy also
   doubles as a permission channel: when the subagent's built-in tools
   need permission, the prompt is forwarded over the socket to the
   dispatcher and rendered as a WebXDC permission prompt in the bound
   chat. Defaults to **sonnet** (or opus per group config) since this is
   where the reasoning happens.

### Subagent message flow

    DC message arrives
      ↓
    Dispatcher's onIncomingMessage classifies it (see "Message classification")
      ↓
    Dispatcher spawns: claude -p
                       --session dc-chat-<chatId>
                       --mcp-config <tools-only.mcp.json>
                       --allowedTools mcp__deltachat-tools__*
                       <inline prompt with message + chat metadata>
      ↓
    Subagent process starts, loads tools-proxy MCP server
      ↓
    Tools proxy reads DC_DISPATCHER_SOCKET + DC_DISPATCHER_SECRET env vars,
    connects to socket, performs handshake
      ↓
    Subagent reasons; calls e.g. dc_send
      ↓
    Tools proxy forwards {tool, args, secret, chat_id} over socket
      ↓
    Dispatcher validates secret + chat_id authorization, executes against DC
      ↓
    Dispatcher returns result over socket
      ↓
    Subagent exits (or handles permission prompt mid-flight, see below)

### Per-chat session continuity

We use Claude Code's `--session dc-chat-<chatId>` flag for context
continuity across messages in the same chat. **Critical: this assumption is
verified by Spike 1A before any production code is written.** If the flag
doesn't behave as assumed, fallback is explicit history passing via
`dc_chat_history` in the inline prompt.

## Phase 0 — SKIPPED

> **Decision (post-v0.8.3):** Phase 0 is dropped. The proposed broadcast
> of permission prompts to all paired chats is chat spam and not
> acceptable. The TOCTOU on `lastActiveChatId` is fixed properly by
> Phase 2, which gives every permission request an unambiguous
> originating subagent → bound `chat_id` → target chat. No heuristics,
> no broadcasts, no races.
>
> Implication: motivation #1 (permission targeting) is no longer
> shippable as a 1-day standalone. It rides along with the full
> subagent rewrite. Until 0.9 ships, the existing single-process
> behavior remains.

## Phase 1 — Feasibility spikes (2-3 days, no commits)

### Spike 1A — Persistent-subagent round-trip latency (REWRITTEN)

The original Spike 1A assumed spawn-per-message and measured cold-start.
Real measurements (`~6 s` cold, `~10 s` resume, ~328 MB RSS) killed that
design; see v7 changelog. The new Spike 1A measures the actual design:
**a persistent `claude -p` process that receives prompts over stdin
(stream-json) and returns responses over stdout (stream-json), kept
alive across messages.**

**Probe commands (verified manually before writing the spike):**

    # Cold-start (one-shot)
    claude -p --session-id <uuid> "<prompt>"

    # Persistent — stream prompts over stdin
    claude -p \
      --session-id <uuid> \
      --input-format stream-json \
      --output-format stream-json \
      --verbose

**Pass criteria:**

1. **Persistent process accepts multiple prompts over stdin.** Send
   two prompts sequentially; receive two distinct responses without
   the process exiting between them.
2. **Second-message round-trip < 2000 ms.** The first prompt pays the
   ~6 s cold-start (model load + token processing); every prompt
   after that should round-trip in well under 2 seconds because the
   model is already loaded.
3. **Parallelism across processes.** Two persistent processes running
   concurrent Bash calls must not interfere — measure with two
   `bash -c "sleep 3"` prompts running in parallel, wall-clock under
   5 s.
4. **RSS ≤ 500 MB per idle persistent process.** Sanity-check that
   idle memory matches the 330 MB probe, so the default cap of 4 is
   not blown out by surprise.

**Fallback if 1A.1 fails:** stream-json stdin isn't actually
persistent → fall back to spawn-per-message with `dc_chat_history`
injection and a mandatory "⏳ thinking…" ack. Document the 6 s cost.

**Fallback if 1A.2 misses the 2000 ms budget:** the LRU cache doesn't
help enough — user still waits multiple seconds per reply. Same ack
pattern, but document that the dc-claude-channel is a slow-turnaround
chat bot, not a real-time assistant.

**Fallback if 1A.3 fails:** parallelism is broken at the process
level, which would be an environment bug — escalate.

**Fallback if 1A.4 fails:** revisit the default cap of 4 downward.

### Spike 1B — MCP server tunneled over Unix socket

50-line toy: server MCP that opens a Unix socket, client MCP that forwards
a single `echo` tool call. Prove handshake, framing, error propagation,
and that `claude -p --mcp-config` actually loads the proxy and calls into
it.

### Spike 1C — `claude -p --allowedTools` flag verification (NEW per Oliver P1)

Confirm `--allowedTools` accepts MCP-prefixed tool names like
`mcp__deltachat-tools__dc_send` and that omitted tools are actually
blocked, not just defaulted-deny-with-prompt. If the flag doesn't exist or
behaves differently, the security story changes — subagents would need
permission prompts for every dispatcher call.

### Spike 1D — `claude -p --model` flag verification (NEW per Oliver P1)

Confirm `claude -p --model haiku` and `--model sonnet` work in headless
mode. Phase 4 depends entirely on this. If it doesn't exist, Phase 4 is
cut.

### Spike 1E — Permission channel registration from an MCP server (NEW)

The permission relay assumes a subagent's `claude -p` process can be told
to route built-in tool permission prompts (Bash, Edit, etc.) through an
MCP server instead of the default terminal prompt. Two questions:

1. Can a single MCP server also register as a permission channel? If yes,
   tools proxy handles both DC tool calls and permission requests over
   the same socket connection.
2. If no, can we load `deltachat-tools` + `deltachat-perms` as two
   separate MCP servers in the subagent, both connecting to the same
   dispatcher socket?
3. Failing both, is there a CLI flag or config option for `claude -p` to
   delegate built-in tool permissions to a custom handler?

If all three fail, the entire architecture is in trouble — built-in tool
permission prompts in subagents would have nowhere to go. **Fallback:**
launch subagents with `--allowedTools Bash,Edit,Read,Grep,Glob,WebFetch`
to skip prompts entirely, accepting that the user has implicitly trusted
the chat owner with full local-machine access. This is actually
defensible — the chat is already paired and owner-verified — but it's a
significant security posture change that needs to be explicit in
SECURITY.md.

### Exit criteria

All four spikes must pass before Phase 2 starts. Any failure either
triggers fallback or cuts the dependent phase.

## Phase 2 — Split the plugin into two MCP servers (4-6 days)

### File structure

    plugin/
      dispatcher/
        server.ts           # owns DC, spawns subagents, hosts socket
        socket-server.ts    # Unix socket listener + protocol
        subagent-spawner.ts # claude -p process management + state machine
        message-router.ts   # classifies incoming messages + WebXDC updates
      tools/
        server.ts           # tools-proxy MCP server
        socket-client.ts    # connects to dispatcher
      shared/
        protocol.ts         # wire protocol types (see below)
        (existing: dc-client.ts, access.ts, tutorial.ts, webxdc-filter.ts, etc.)

### Wire protocol (Alice [W] socket framing concern; Oliver P1 schema gap)

Newline-delimited JSON over Unix stream. Every message has a `kind` field.

```typescript
// shared/protocol.ts

export type ClientMessage =
  | { kind: 'hello'; secret: string; subagentId: string; chatId: number }
  | { kind: 'toolCall'; id: string; tool: string; args: Record<string, unknown> }
  | { kind: 'permissionResponse'; id: string; verdict: 'allow' | 'deny' }
  | { kind: 'bye' }

export type ServerMessage =
  | { kind: 'helloAck'; sessionId: string }
  | { kind: 'toolResult'; id: string; result: ToolResult }
  | { kind: 'toolError'; id: string; error: { code: string; message: string } }
  | { kind: 'permissionRequest'; id: string; tool: string; input: unknown }
  | { kind: 'webxdcUpdate'; appId: string; msgId: number; payload: unknown }

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}
```

Validation: every inbound message is parsed with a Zod schema in
`socket-server.ts` and rejected with a `toolError` reply on schema
mismatch. This is the only trust boundary; treat the socket like an
external API.

### Socket security

- **Path:** `${CLAUDE_PLUGIN_DATA}/dispatcher.sock` — already user-scoped.
- **File mode:** `chmod 0600` immediately after `bind()`. Rejects any
  process not running as the same UID. Alice [break] flagged the missing
  mode.
- **Shared secret:** `crypto.randomBytes(32).toString('hex')`. Generated
  fresh per dispatcher start, passed to subagents via `DC_DISPATCHER_SECRET`
  env var. Constant-time comparison on the server side. Oliver P2 flagged
  unspecified entropy.
- **Subagent ID:** included in `hello` so the dispatcher can correlate
  socket connections to spawned processes. Rejects any `hello` whose
  subagentId isn't in the dispatcher's spawn map.
- **chat_id authorization:** every `toolCall` includes the originating
  chat_id from the `hello`. The dispatcher rejects tool calls whose
  `args.chat_id` doesn't match. Prevents a compromised subagent from
  acting on a different chat.

### Message classification (NEW — Alice [break] WebXDC routing)

The dispatcher's `onIncomingMessage` and WebXDC update handler must classify
events and route them correctly. There are three classes of incoming
events:

| Event | Source | Routing |
|---|---|---|
| Regular DC message | `onIncomingMessage` | Auto-pair branch (v0.8.3) approves silently if sender is a known owner; otherwise gate via `access.isAllowed`. Then spawn subagent for chat. |
| System message (member removed, etc.) | `onIncomingMessage` | Handled in dispatcher. `normalizeSystemMessageType` (v0.8.3) already strips dc-core's 'Unknown' default; `cleanupChat` already extracted for the IncomingMsg path. |
| Self-initiated leave (chat owner leaves group from their device) | `ChatModified` event (v0.8.3) | Same `cleanupChat` helper. Already shipped — dispatcher just keeps the existing subscription. |
| WebXDC update — `version_mismatch` | webxdc poll | Handled in dispatcher: rebuild + resend `.xdc`, no subagent involved |
| WebXDC update — permission verdict | webxdc poll | Forward to **originating subagent's** open socket (see permission relay) |
| WebXDC update — file reviewer comments | webxdc poll | Spawn fresh subagent for the chat with comments embedded in prompt |
| WebXDC update — other | webxdc poll | Spawn fresh subagent for the chat |

**Inherited from v0.8.3 (no rework needed):**
- Auto-pair: `server.ts` already silently approves new chats from known owners. Dispatcher reuses this branch verbatim — no per-chat pairing handshake to design around.
- SessionStart hook: when zero chats are paired, the plugin's hook surfaces the `/deltachat:configure` invite. The dispatcher inherits this for first-run onboarding; no subagent path involvement.
- `cleanupChat` helper: already extracted in v0.8.3 to serve both `IncomingMsg` and `ChatModified` triggers. Dispatcher calls it directly.

Critical: WebXDC updates **never** depend on a currently-running subagent
unless they are permission verdicts for a still-open prompt. File reviewer
comments arrive when no subagent is active — the dispatcher must spawn one.

### Two classes of tool calls

| Tool class | Examples | Where it runs | Permission flow |
|---|---|---|---|
| Built-in Claude Code | Bash, Edit, Read, Grep, Glob, WebFetch | **Locally in subagent** | Subagent's permission system → tools proxy → dispatcher → WebXDC prompt in bound chat → user → back |
| DC-specific (proxied) | dc_send, dc_send_file, dc_chat_history, dc_test_permission | **In dispatcher** (DC lock) | Pre-authorized: tool call validated against subagent's bound chat_id and access.ts allowlist; no user prompt |

DC-specific tools are pre-authorized because (a) the dispatcher already
trusts the subagent — it spawned it with the shared secret and bound it
to a chat, and (b) prompting the user to approve every `dc_send` would be
maddening. Authorization is enforced at the socket boundary: every
proxied tool call must match the subagent's bound `chat_id`.

Built-in tools are where the real permission flow lives, and where this
architecture earns its keep — Bash running inside subagent N for chat A
doesn't block Bash running inside subagent M for chat B.

### Permission relay (full sequence)

    Subagent (chat A) Claude Code wants to run Bash
      ↓
    Subagent's permission system fires: permission_request
      (subagents are launched with the tools proxy registered as their
       permission CHANNEL — the same channel-plugin protocol the
       dispatcher uses today, just over a different transport)
      ↓
    Tools proxy receives permission_request, sends over socket:
      {kind: 'permissionRequest', id: P1, tool: 'Bash', input: {...}}
      ↓
    Dispatcher socket-server receives, looks up which subagent sent it
      (by socket connection → subagent spawn record → chat_id), then
      hands to permissions-app to render a WebXDC permission prompt
      in chat A's permission app instance
      ↓
    Dispatcher tracks: pendingPermissions.set(P1, {socket, subagentId, chatId})
      ↓
    User taps Allow/Deny in Delta Chat
      ↓
    Dispatcher's WebXDC poll receives the update via webxdc-filter
      (owner-verified — only the chat owner can answer)
      ↓
    Dispatcher looks up P1 in pendingPermissions, sends over the
      originating socket: {kind: 'permissionResponse', id: P1, verdict}
      ↓
    Tools proxy receives the response, hands to subagent's permission
      system, which resumes Bash (or rejects)

Critical state:

- `pendingPermissions: Map<string, {socket, subagentId, chatId, expiresAt}>`
  in the dispatcher. Keyed by request ID, NOT by chat. Multiple chats can
  have pending permissions concurrently — that's the whole point.
- The mapping from "WebXDC verdict update" → "which pending permission"
  comes from the existing permissions-app message correlation (request_id
  embedded in the WebXDC update payload). This already exists today.
- Pending permissions expire after a configurable timeout (default 10
  min). Expired requests deny by default and notify the chat.

**Critical invariant:** the dispatcher itself never runs Bash/Edit. The
dispatcher's main Claude Code session is the user's terminal session and
runs whatever the user types. Only subagents run tools on behalf of chat
messages. This avoids the question "where does a Bash from the dispatcher
get its permission prompt routed" — the dispatcher's tools route via the
existing permissions-app the same way they do today.

### Built-in tool permission channel — how the proxy registers

This is the load-bearing assumption for the whole permission relay and
needs verification in **Spike 1E** (added below). Claude Code supports
"channels" as a mechanism for permission delegation; the deltachat plugin
already uses it. The question: can a single MCP server *also* register as
a permission channel for the same Claude Code process? If yes, the tools
proxy doubles as both. If no, we need to load two MCP servers in the
subagent — `deltachat-tools` (for proxied DC tools) and `deltachat-perms`
(for permission relay) — both connecting to the same dispatcher socket
with different `kind` discriminators.

Either way, the wire protocol already supports it (`permissionRequest` /
`permissionResponse` are first-class kinds in the schema below). The
question is purely about how the MCP/channel registration works
client-side.

### Subagent process lifecycle state machine (Oliver P2)

Replace the bare `Map<chatId, ChildProcess>` with an explicit state
machine. Per chat:

    states: Idle | Spawning | Running | Draining | Exited
    transitions:
      Idle → Spawning      (incoming message)
      Spawning → Running   (hello received over socket)
      Spawning → Exited    (process died before hello — error to chat)
      Running → Draining   (process exited normally OR timeout)
      Running → Exited     (process killed)
      Draining → Exited    (final socket messages flushed)

Per-chat queue: while a chat is in `Running`, incoming messages queue up
to a max depth of 10. Overflow drops the oldest queued message and sends
"⚠️ message dropped, agent busy" to the chat.

### Tool dispatch in dispatcher

The dispatcher's MCP server (the one connected to the user's terminal
Claude Code) keeps registering all the existing tools so the user's main
session still works. The socket-server is a *parallel* dispatch path —
same dc-client, same access.ts checks, just a different transport.

## Phase 2.5 — DELETED

Replaced by the LRU cache of persistent subagents (now part of Phase 2
proper). Warm-start via `--resume` measured at ~10 s, so pre-warming
cold processes doesn't solve the latency problem. See the v7 changelog
at the top of this document.

## Persistent subagent processes (LRU cache) — canonical design

The dispatcher keeps a bounded cache of live `claude -p` processes,
one per recently active chat. This replaces both "spawn per message"
(v3-v6) and the "warm pool" (v6 Phase 2.5).

### Cache shape

    activeSubagents: LRU<chatId, SubagentProcess>

    SubagentProcess = {
      chatId: number
      pid: number
      sessionId: string           // UUID passed to --session-id
      stdin: Writable             // for sending new prompts
      stdout: Readable            // for receiving responses
      lastUsed: number            // LRU timestamp
      idleTimer: NodeJS.Timeout   // self-exit after N minutes idle
      state: 'idle' | 'busy'
    }

### Sizing

- `DC_SUBAGENT_MAX_ACTIVE` — cap on live processes. Default **4**.
  Valid range 1-16. Rationale: ~328 MB RSS per process × 4 = ~1.3 GB,
  reasonable for a workstation and enough to keep the common case
  (few active chats) fully warm.
- `DC_SUBAGENT_IDLE_TIMEOUT_MIN` — how long a cached subagent stays
  alive without new messages. Default **15 min**. Subagent self-exits
  on timeout; dispatcher cleans up the cache slot.

### Dispatch algorithm

On `onIncomingMessage(chat, prompt)`:

1. If `activeSubagents.has(chatId)`:
    - Touch LRU position.
    - If `state === 'busy'`: queue prompt (max depth 10).
    - If `state === 'idle'`: mark busy, send prompt via stdin,
      stream stdout back to DC. Latency target: first byte under 1 s
      because model + context are already loaded.
2. If `activeSubagents.has(chatId) === false`:
    - If `activeSubagents.size >= DC_SUBAGENT_MAX_ACTIVE`: evict the
      LRU process (SIGTERM, wait 2 s, SIGKILL fallback).
    - Spawn a new `claude -p --session-id <uuid> --input-format
      stream-json --output-format stream-json <other flags>`.
    - Send the prompt. This path pays the ~6 s cold-start; dispatcher
      immediately sends `⏳` (or similar) to the chat as an ack so the
      user knows something is happening.
    - Insert into cache.

### Eviction and crash handling

- `child.on('exit')`: remove from cache. If exit was non-zero, log and
  send an error message to the bound chat. Next message for that chat
  re-spawns.
- Dispatcher shutdown: SIGTERM all cached subagents, wait for exits.
- Orphan cleanup on dispatcher restart: `pgrep` for
  `claude -p --session-id dc-chat-*` and SIGTERM. (Reuses the Phase 3
  design.)

### Continuity

Each subagent is spawned with `--session-id <uuid>` and stays alive —
we don't need `--resume` at all. The process itself holds the
conversation state in memory. If the subagent exits (idle timeout,
crash, eviction), the next message re-spawns with the same UUID and
passes the last N messages via `dc_chat_history` in the initial
prompt. `--resume` is too slow (10 s) to be useful for us.

### Per-chat serialization

One process per chat means one in-flight message at a time for that
chat — automatic. The per-chat queue (depth 10) only matters when
multiple messages arrive while Claude is still generating the prior
response.

### Parallelism across chats

Different chats have different processes, so Bash running in chat A's
subagent doesn't block Bash running in chat B's subagent. This is the
core architectural win, preserved from v3.

## Phase 3 — Per-chat queue, timeouts, and cleanup (2-3 days)

1. **Subagent crash:** `child.on('exit')` with non-zero code → log, send
   error to chat, drain queue, transition to Idle.
2. **Subagent timeout:** configurable (default 5 min), env-overridable via
   `DC_SUBAGENT_TIMEOUT_MS`. SIGTERM, then SIGKILL after 10s. Document
   default in CLAUDE.md.
3. **Per-chat serialization:** queue depth 10, overflow drops oldest with
   user notification. Configurable via `DC_SUBAGENT_QUEUE_MAX`.
4. **Dispatcher restart with orphans:** on startup, `pgrep` for
   `claude -p --session dc-chat-*` and SIGTERM. The new secret invalidates
   any that survive.
5. **Tool call rate limit:** 100/min per subagent, configurable via
   `DC_SUBAGENT_RATE_LIMIT`. Excess tool calls return `toolError` with
   `code: 'rate_limited'`.
6. **Per-chat → per-process correlation:** the spawn map and queue are the
   only sources of truth for "is chat N busy". No global counters.

## Phase 4 — Model defaults and per-group override (1 day, gated on Spike 1D)

**Inverted defaults:** the dispatcher does routing/plumbing only and
defaults to **haiku**. Subagents do reasoning over tool output and
default to **sonnet**. Per-chat or per-group config can override the
subagent model to opus (or down to haiku for cheap chats).

```typescript
// Validated against an allowlist (Oliver P2 — input validation)
const ALLOWED_MODELS = ['haiku', 'sonnet', 'opus'] as const
type AllowedModel = typeof ALLOWED_MODELS[number]

export interface GroupContext {
  name: string
  prompt: string
  model?: AllowedModel  // overrides subagent default of 'sonnet'
}
```

`dc_update_group_prompt` validates `model` against `ALLOWED_MODELS` and
rejects unknown values with a clear error. No silent fallback.

When the dispatcher spawns a subagent for a group with a configured model,
pass `--model <model>` to `claude -p`. Otherwise pass `--model sonnet`.

The dispatcher's own model is set when the user launches Claude Code in
their terminal — we don't control that and don't try to. The
recommendation in CLAUDE.md and README will be: "for the dc-claude-channel
plugin, the dispatcher session can run on haiku since subagents handle
the reasoning."

## Phase 4 additions (post-v8 planning)

### Per-chat permission mode opt-out

Extend `GroupContext` with `permissionMode?: 'default' | 'bypassPermissions'`
(default: `'default'`). The subagent spawn factory reads this from
the group config and:

- `default` → generate per-subagent hook config, launch with
  `--settings <hook-cfg> --permission-mode default` (Phase 2 behavior).
- `bypassPermissions` → skip the hook config entirely, launch with
  `--permission-mode bypassPermissions`. No WebXDC prompts ever.
  Useful for automation-style groups where the owner explicitly
  wants no interruption.

The `dc_update_group_prompt` tool gains an optional `permission_mode`
field validated against the enum. Rejected for unknown values.
Document the security implication in CLAUDE.md: "choosing
bypassPermissions grants the subagent full access to the CWD
sandbox's allowed directories; use only for trusted automation."

### Reactions as status channel and command surface

`@deltachat/jsonrpc-client` exposes `sendReaction(accountId, msgId, reaction)`
and emits `IncomingReaction` / `ReactionsChanged` events. Phase 4
wires both directions:

**Outbound — dispatcher reacts to user messages as status:**

| Emoji | Meaning |
|---|---|
| 🔄 | Spinning up a new subagent (cold spawn) |
| 🧠 | Subagent ready, running on the default model (sonnet = 2 brains) |
| 🧠 × 1 | Running on haiku |
| 🧠 × 3 | Running on opus |
| 🍳 | Creating a new group chat |
| ✅ | Turn completed successfully |
| ⚠️ | Completed with permission denials |
| ❌ | Turn errored |

Reactions are additive and the last reaction wins per emoji — so
the dispatcher can add 🔄 on dispatch and then replace with 🧠
when the subagent is ready.

**Inbound — reactions as user commands:**

When the bot receives an `IncomingReaction` from the chat owner on
one of its own messages, it treats certain reactions as commands:

| Input | Command |
|---|---|
| `🧠` | Switch subagent to default model (sonnet) |
| `🧠🧠` (two brain emoji in one reaction string) | Switch to sonnet |
| `🧠🧠🧠` | Switch to opus |
| `➕🧠` | Step up one tier (haiku → sonnet → opus) |
| `➖🧠` | Step down one tier (opus → sonnet → haiku) |

Brain-count reactions trigger a subagent close + respawn with the
new `--model` (uses the Phase 4 per-group model mechanism).
Non-owner reactions are ignored (same owner rule as messages).

This is an opt-in surface — users who don't know about it see only
the status reactions, which are self-explanatory.

### Cross-chat conversation search (`dc_search_chats`)

Simple form of memory: let any subagent search across the chats its
owner has access to, so the user can reference past conversations
("what did I tell you about the rust port last week?") without
manually pasting context.

**New tool:** `dc_search_chats` exposed to every subagent via the
tools-proxy MCP server.

**Args:**
- `query` (string, required) — full-text search term
- `chat_id` (string, optional) — restrict to a single chat; defaults
  to "all chats this owner can access"
- `limit` (number, optional, default 20)
- `since` (ISO timestamp, optional) — only match newer messages

**Result rows:**

```typescript
{ chat_id, chat_name, msg_id, sender, snippet, timestamp }
```

**Implementation:**

- Prefer DC's built-in search RPC if `@deltachat/jsonrpc-client`
  exposes one (`search_messages` exists in dc-core; verify it's
  available on the client). Falls back to client-side scanning of
  `getChatHistory(chatId, N)` per accessible chat with a hard cap on
  scan depth (e.g. last 200 messages per chat) to avoid runaway.
- Snippet generation: ~80 chars centered on the match.
- Results sorted newest-first.

**Authorization (the load-bearing rule):**

The calling subagent is bound to a specific chat, but the search
tool legitimately needs cross-chat read access. Restrict the result
set to "chats whose owner matches the calling subagent's owner".
Concretely:

1. Look up `ownerAddr = access.getOwnerAddr(callingChatId)`.
2. Build `accessibleChats = access.allowedChats().filter(id =>
   access.getOwnerAddr(id) === ownerAddr)`.
3. Execute the search only against `accessibleChats`.
4. If `args.chat_id` is provided, intersect with `accessibleChats`
   and return an empty result if outside the set (do not error —
   make it look like "no matches").

This means a chat owner can search across all their chats but never
across other people's. It also means a member of someone else's
group can't pivot to read other groups via the search tool.

**UX in DC:**

When results come back, the subagent quotes them inline ("I found
this from chat 'Rust Port' on Apr 3: ...") or — if DC supports
message-id deep links via `mid:` URIs — formats them as tappable
links so the user can jump to the original message in their DC
client.

**Future extension (deferred):**

- Embedding-based semantic search instead of literal full-text — out
  of scope for Phase 4. The full-text version is enough to ship.
- Per-chat indexing daemon — not needed; dc-core's search is fast
  enough for the bot's volume.
- "Memory facts" extraction — a separate feature, not this one.

## Phase 5 — Migration (1 day)

- Update CLAUDE.md architecture section.
- **No `DC_CHANNEL_SINGLE_PROCESS` escape hatch** — Oliver flagged it as a
  Ghost API risk (#6). Either the rewrite ships and works, or we revert
  the merge. The previous-version code stays accessible via git tag
  `v0.8.3` for users who need to roll back.
- Version bump to 0.9.0 in plugin.json and marketplace.json.
- Migration test: existing paired chat works after upgrade. State files
  (`approved/`, `dc-data/`, `.welcomed`) unchanged.
- **No re-pairing required.** v0.8.3's auto-pair + SessionStart hook
  remain the only onboarding paths. The dispatcher inherits both
  unchanged — users upgrading from v0.8.3 see no pairing prompts.

## Phase 6 — Testing (3-4 days)

### Unit tests

- `socket-server.test.ts` — handshake, schema validation, secret
  validation, chat_id authorization, disconnect, malformed messages
- `socket-client.test.ts` — reconnect, error serialization
- `subagent-spawner.test.ts` — state machine transitions, timeout, orphan
  cleanup, queue overflow
- `message-router.test.ts` — classification of every event type from the
  table above; especially file reviewer comments arriving with no active
  subagent
- `protocol.test.ts` — Zod schema round-trip + rejection cases

### Integration tests (manual checklist)

- Single chat: message → subagent spawns → reply → exits
- Two chats interleaved: parallel execution verified by timestamps
- Two chats rapid-fire: per-chat serialization holds, no cross-chat leak
- Slow tool call in chat A doesn't block chat B
- File reviewer comments arrive when no subagent active → fresh subagent
  spawns, reads comments, updates file
- Permission prompt fires from dispatcher's main session, targets correct
  chat
- Group with `model: haiku` → `--model haiku` actually used (verify via
  process listing)
- Dispatcher restart with active subagents → orphans cleaned up
- Queue overflow → oldest dropped, user notified
- Malformed socket message → rejected, dispatcher stays up
- Wrong secret → connection refused, logged
- Wrong chat_id in tool call → rejected, logged

### Stress test

- 5 paired chats, message every 10s for 5 min
- Memory: dispatcher RSS stable, no subagent leak
- No deadlocks, all messages replied to under 30s

## Risks summary

| Risk | Severity | Mitigation |
|---|---|---|
| Spike 1A: named sessions don't work | **High** — kills plan | Fallback: explicit `dc_chat_history` injection |
| Spike 1A: parallel `claude -p` serializes internally | **High** — loses concurrency | Same fallback, accept serial dispatch |
| Spike 1C: `--allowedTools` flag missing | **High** — security model | Restrict subagents further; revisit |
| Spike 1D: `--model` flag missing | **Medium** — cuts Phase 4 | Drop Phase 4 |
| Subagent cold start latency 2-5s | **Medium** — UX | Document. Persistent subagent variant in 1.0+ |
| Per-chat ordering breaks under concurrency | **Medium** | Per-chat queue + state machine prevents |
| Socket security: local privilege escalation | **Medium** | 0600 mode + 32-byte secret + UID-scoped path |
| MCP-over-socket protocol fragility | **Medium** | Spike 1B + Zod validation at trust boundary |
| Token cost explosion from cold spawns | **Low** | Document; user opts in per chat |
| WebXDC update arrives during subagent crash | **Medium** | Router classifies independently; never depends on subagent state |
| Hardcoded timeouts wrong for some users | **Low** | All env-overridable |

## Estimated timeline

- Phase 0: **skipped** (rolled into Phase 2; broadcast was chat spam)
- Phase 1 (spikes): 2-3 days → **go/no-go gate**
- Phase 2 (split + permission relay): 4-6 days
- Phase 2.5: **deleted** (subsumed by the LRU persistent-subagent cache in Phase 2)
- Phase 3 (lifecycle): 2-3 days
- Phase 4 (model selection, gated): 1 day
- Phase 5 (migration): 1 day
- Phase 6 (testing): 3-4 days

**Total: ~2.5-3.5 weeks of focused work.**

## Decision points

1. **Phase 0 skipped.** Broadcast-to-all-chats was chat spam. Permission
   targeting is fixed properly by Phase 2 via the subagent → bound
   `chat_id` mapping.
2. **Subagents run full tools.** Bash/Edit/Read run locally inside the
   subagent — that's where the parallelism wins come from. Only DC tools
   proxy back to the dispatcher because of the lock.
3. **Permission relay is fully specified** in Phase 2. Built-in tool
   permission prompts route from subagent → tools proxy → dispatcher →
   WebXDC prompt → user → back. Spike 1E verifies the load-bearing
   assumption that an MCP server can register as a permission channel.
4. **Model defaults inverted:** dispatcher defaults to haiku (routing),
   subagents default to sonnet (reasoning). Per-group override to opus
   for heavy chats.
5. **No escape hatch.** If the rewrite breaks, revert via git tag.
6. **Push to 1.0?** Recommend Phase 0 in 0.9, full rewrite in 1.0. Keeps
   0.9 focused on allowlist submission + SECURITY.md.

## Open questions for the user

1. Spike 1E is the new biggest unknown. If permission channels can't be
   served by an MCP server, the fallback is `--allowedTools` with all
   built-in tools pre-allowed (chat owner gets full local-machine access
   without per-action prompts). Acceptable as a posture, or hard line?
2. ~~Phase 0 in 0.9, full rewrite in 1.0 — or all-in on 0.9?~~ Resolved: Phase 0 dropped, full rewrite in 0.9.
3. Acceptable to drop Phase 4 if Spike 1D fails?
