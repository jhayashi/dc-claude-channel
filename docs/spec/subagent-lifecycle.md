# Subagent Lifecycle + Dispatcher Internals

## Feature: Subagent lifecycle + dispatcher internals

### Intended behavior

**Subagent spawning and lifecycle:**
- One persistent `claude -p` process per chat, spawned on demand by the dispatcher when a message arrives.
- First spawn creates a new session (UUID + `--session-id` flag); subsequent spawns on the same chat reuse the UUID with `--resume` to rehydrate turn history.
- Subagents communicate with the dispatcher via Unix socket using newline-delimited JSON; each connection authenticates with a shared secret and identifies its role (`tools` or `hook`).
- Subagent stdout is consumed as stream-json frames; the dispatcher watches for `type: 'result'` frames to complete a turn.
- Permission requests are serialized through a PreToolUse hook script that relays to the dispatcher's socket server and blocks awaiting a verdict.
- DC tool calls flow back to the dispatcher via a spawned MCP server (`tools-proxy.ts`) that forwards each CallTool request to the socket server.

**Cache and eviction:**
- An LRU cache holds up to `DC_SUBAGENT_MAX_ACTIVE` (default 8) active subagents; when at capacity, the least-recently-used chat's subagent is evicted.
- Each cached subagent has an idle timeout (`DC_SUBAGENT_IDLE_MIN`, default 480s); after idle timeout, it is closed and removed from the cache.
- Queue depth per chat is capped at `DC_SUBAGENT_QUEUE_MAX` (default 10); overflowing messages drop the oldest queued message.
- Crash detection: if a subagent is found dead between turns (`alive=false`), it is evicted and a callback fires (used for cleanup/logging).
- Pre-warming: `cache.prewarm(chatId)` spawns a subagent without sending a turn, used at pairing time to pay the cold-spawn cost upfront.

**Permission round-trip:**
- When Claude attempts a gated tool (Bash, Edit, Write, WebFetch, WebSearch, NotebookEdit), the PreToolUse hook fires.
- Hook script reads the tool payload from stdin, fast-paths auto-allow for safe read-only Bash commands (date, pwd, whoami, uname), then delegates to `permission-hook-client.ts`.
- Client helper connects to the dispatcher's Unix socket, sends `permissionRequest` frame with the tool name and input, and blocks on `permissionVerdict`.
- Dispatcher routes the request to a permission handler which either auto-approves (skip-permissions agent) or shows a WebXDC permission card to the user.
- Verdict flows back to the hook client on the same connection; hook exits 0 (allow) or 2 (deny), forwarding the user's choice back to Claude.

**Observable tool calls:**
- All tool calls from DC go through the tools-proxy MCP server, which forwards them to the dispatcher's socket server as `toolCall` frames.
- The dispatcher executes the tool (delegating most to the DC client or legacy code paths) and returns a `toolResult` frame with the result or a `toolError` frame if anything fails.
- Activity reactions are emitted for tool use (reading emoji for Read/Grep, coding emoji for Edit/Write, etc.); a random thinking emoji fires at turn start before any tool.

### State machine / transitions

**Subagent states:**
- **Cold**: Chat has never been used, or the subagent was evicted. No process exists.
- **Spawning**: A subagent process is starting (`spawn()` call in progress). Still no process assigned to cache yet.
- **Active**: Subagent process is alive, cached, and ready. `lastUsed` is updated on every touch. Idle timer is reset on every dispatch or touch.
- **Idle**: Subagent exists in cache but no turn has arrived for `idleTimeoutMs`. Idle timer expires → `evict()` fires.
- **Busy**: Subagent is currently processing a turn (`busy=true`). Additional incoming turns queue. Queued turns execute sequentially via `runOrQueue()` → `runNow()`.
- **Evicted**: Subagent was removed from cache (LRU eviction, idle timeout, or crash detected). Process is closed. Any queued work is failed with "subagent evicted" error.
- **Crashed**: Process died unexpectedly (detected when `alive=false` after a send attempt or between turns). Evict and fire `onCrash()` callback.

**Permission request states:**
- **Sent**: Hook client sends `permissionRequest` frame to dispatcher socket server.
- **Pending-verdict**: Dispatcher's socket server queues the request for the user (WebXDC card) or auto-approves (skip-permissions). Hook client waits on socket.
- **Approved**: Dispatcher sends `permissionVerdict` with `verdict='allow'`. Hook exits 0. Claude proceeds with the tool.
- **Denied**: Dispatcher sends `permissionVerdict` with `verdict='deny'`. Hook exits 2, printing deny reason to stderr. Claude sees the denial.
- **Timeout**: Hook's timeout (default 300s, `DC_HOOK_TIMEOUT_SEC`) expires. Shell wrapper exits 2. Treated as denial.

### Persisted state

**Subagent-side persisted state:**
- Per-subagent session UUID (stable across restarts of the same chat). Stored in bindings; passed to subagent on spawn.
- Per-subagent `settings.json` file (temp directory, cleaned up on subagent close) containing PreToolUse hook config and gated tool list.
- Per-subagent `mcp-config.json` (temp directory) pointing to tools-proxy and tools manifest.
- Turn history is stored in-process by Claude Code (`-p` mode); when a subagent is resumed, the prior history is rehydrated.

**Dispatcher-side persisted state:**
- Rate limit bucket timestamps (`RateLimiter`) for each chat, survives subagent respawn so a crash loop cannot refill the budget.
- Scheduled jobs store (see `scheduling.md`) in `~/.claude/channels/deltachat/schedules/`.
- Audit log (`~/.claude/channels/deltachat/audit/<chatId>.md`) records tool calls when skip-permissions is enabled (see `skip-permissions-audit.md`).
- Debug log (`~/.claude/channels/deltachat/debug.log`) for troubleshooting.

**Environment variables (set by dispatcher on spawn):**
- `DC_DISPATCHER_SOCKET`: Absolute path to Unix socket the subagent connects back to.
- `DC_DISPATCHER_SECRET`: 32-byte hex string for socket authentication (random per dispatcher startup).
- `DC_SUBAGENT_ID`: Unique subagent id (random UUID), used in socket hello and for registry lookup.
- `DC_SUBAGENT_CHAT_ID`: The chat id this subagent is bound to (integer). Enforced at socket boundary.
- `DC_HOOK_TIMEOUT_SEC`: Max seconds to wait for permission verdict (default 300).
- `DC_TOOLS_MANIFEST`: Path to JSON array of tool definitions (name, description, inputSchema) exposed by tools-proxy.

**Dispatcher-controlled environment variables (read from process.env or .env file):**
- `DC_SUBAGENT_MAX_ACTIVE`: Max concurrent cached subagents (default 8, min 1, max 16).
- `DC_SUBAGENT_IDLE_MIN`: Idle timeout in minutes (default 480 = 8 hours).
- `DC_SUBAGENT_TURN_TIMEOUT_MIN`: Max turn duration in minutes (default 60).
- `DC_SUBAGENT_QUEUE_MAX`: Max queued prompts per chat (default 10, min 1, max 1000).
- `DC_SUBAGENT_RATE_LIMIT`: Max tool calls per chat per window (default 100, min 1, max 10000).

### Observable surface

**Unix socket path and frame types:**

Socket path: `~/.claude/channels/deltachat/dispatcher.sock` (mode 0o600)

Frame format: Newline-delimited JSON, Zod-validated at boundary.

**Client → Server frames:**
- `hello`: `{ kind: 'hello', secret: string, role: 'tools'|'hook', chatId: number, subagentId: string }`. Must be first frame on any connection.
- `toolCall`: `{ kind: 'toolCall', id: string, tool: string, args: object }`. Only from tools-proxy (`role='tools'`).
- `permissionRequest`: `{ kind: 'permissionRequest', id: string, tool: string, input: unknown }`. Only from hook (`role='hook'`).
- `bye`: `{ kind: 'bye' }`. Graceful close signal.

**Server → Client frames:**
- `helloAck`: `{ kind: 'helloAck' }`. Response to successful hello.
- `toolResult`: `{ kind: 'toolResult', id: string, result: { content: [...], isError?: boolean } }`. Response to `toolCall`.
- `toolError`: `{ kind: 'toolError', id: string, error: { code: string, message: string } }`. Error response to `toolCall` or bad hello.
- `permissionVerdict`: `{ kind: 'permissionVerdict', id: string, verdict: 'allow'|'deny', message?: string }`. Response to `permissionRequest`.

**Permission hook execution:**
- Shell wrapper (`permission-hook.sh`) handles timeout (default 300s), fast-path auto-allow for safe Bash commands, and error translation (exit 2 = deny).
- Bun client (`permission-hook-client.ts`) handles socket I/O and frame marshaling. Exit codes: 0 = success, non-zero = failure (treated as deny).
- Hook is invoked by Claude Code PreToolUse mechanism; input is JSON on stdin, output is "allow" or "deny: <message>" on stdout, exit code to Claude.

**Activity reactions (emoji contract):**
- Reaction is tied to the user's turn message ID, set at turn start by `setTurnTarget(msgId)` which emits a random thinking emoji.
- `reactForTool(toolName, toolInput)` maps tool classes to emoji pools:
  - `coding` (Edit/Write) → ✏️/🎨
  - `reading` (Read/Grep) → 🔍/👀
  - `running` (Bash) → ⚙️/🔧
  - `planning` (EnterPlanMode) → ✍️/🗺️
  - `delegating` (Task) → 🤝
  - `todo-*` → keycap/regional indicator
- Emojis are debounced by class; if the last tool was also coding, the same message ID gets no new reaction.
- `clearTurnTarget(chatId)` drops state at turn end (emoji remains visible).

**Subagent stdout/stderr handling:**
- Stdout is parsed as newline-delimited JSON stream frames. Frames are buffered and matched against predicates (e.g., `f.type === 'result'`). Unmatched frames are re-queued.
- Stderr lines are logged to debug.log with subagent id prefix. No automatic error handling; stderr does not cause turn failure.
- Turn timeout is enforced by `readFrame(predicate, timeoutMs)`, which polls the deadline and re-arms if extended by `extendDeadline()` (used to pause timeout during permission prompts).

### Primary source files

| File | Purpose |
|------|---------|
| `plugin/dispatcher/subagent-cache.ts` | LRU cache of active subagents per chat; spawn-on-demand, idle timeout, eviction, queue depth, crash detection. |
| `plugin/dispatcher/subagent-process.ts` | Wraps `claude -p` child process; stream-json I/O, stdin writes, stdout frame parsing, turn timeout with deadline extension. |
| `plugin/dispatcher/socket-server.ts` | Unix socket listener; hello frame auth (secret + subagentId + chatId validation), connection routing, out-of-band frame delivery. |
| `plugin/dispatcher/permission-hook.sh` | PreToolUse shell wrapper; timeout handling, fast-path for safe Bash, error translation (exit 2 = deny). |
| `plugin/dispatcher/permission-hook-client.ts` | Bun helper spawned by hook.sh; socket I/O, hello + `permissionRequest` / `permissionVerdict` frame exchange. |
| `plugin/dispatcher/hook-config.ts` | Generates per-subagent `settings.json` with PreToolUse hooks and per-subagent `mcp-config.json` with tools-proxy. |
| `plugin/dispatcher/tools-proxy.ts` | Per-subagent MCP server; loads tool manifest, listens for CallTool, forwards to dispatcher socket as `toolCall` frames, maps `toolResult`/`toolError` responses. |
| `plugin/dispatcher/message-router.ts` | Classifies Delta Chat events; system vs. user messages, paired vs. unpaired, authorized vs. unauthorized. Routes to cache or legacy paths. |
| `plugin/dispatcher/reaction-router.ts` | Buffers and debounces emoji reactions; checks allowlist, owner, and live-subagent status; dispatches synthetic user turns. |
| `plugin/dispatcher/activity-reactions.ts` | Emoji pool selection by tool class; thinking emoji at turn start; deduping by class. |
| `plugin/dispatcher/rate-limit.ts` | Per-chat sliding-window token bucket for tool-proxy calls; survives subagent respawn. |
| `plugin/dispatcher/skip-permissions.ts` | Auto-approve path for skip-permissions agents; see `skip-permissions-audit.md`. |
| `plugin/dispatcher/orphan-cleanup.ts` | Dispatcher startup sweep for stale `claude -p` processes from prior crashed dispatcher (Linux/macOS only). |

### Audit notes

**Races and concurrency concerns:**

1. **Cache eviction during active permission hook** (`subagent-cache.ts`, `subagent-process.ts`):
   - If a hook request is in flight and the LRU cache evicts the subagent's entry, the hook client may attempt to write to a closed socket or receive no verdict. The hook's timeout (300s default) will trigger and exit 2, but the user sees a denial instead of a clean cancellation.
   - Root cause: socket-server does not track which hook connection maps to which chat entry.
   - Mitigation: `extendDeadline()` can be called to pause the turn timeout, but this only extends the subagent-side deadline, not the hook-side timeout.

2. **Queue overflow drops during active turn** (`subagent-cache.ts`):
   - If `entry.busy` is true and the queue is at max, the oldest queued message is dropped with "queue overflow". If that message is a critical system message (e.g., user cancels), it is silently lost.
   - No priority mechanism for retrying or replaying dropped messages.

3. **Crash detection race** (`subagent-process.ts`, `subagent-cache.ts`):
   - If a subagent dies mid-turn, `entry.sub.alive` becomes false. The `send()` catches this and calls `onCrash()`. However, if the cache is simultaneously evicted (LRU or timeout), `evict()` also calls `close()` without checking alive.
   - No double-close guard; if two code paths race to close the same process, the second gets an error (caught, but noisy logging).

4. **Socket authorization at chat_id boundary** (`socket-server.ts`, `tools-proxy.ts`):
   - When hello arrives, the dispatcher verifies that the subagentId maps to the correct chatId. However, if the binding registry is updated (agent re-paired, chat reassigned) AFTER hello but BEFORE the tool call, the tool executes with stale authorization.
   - The tools-proxy embeds chatId in every `toolCall` frame, but the dispatcher only validates it once at hello. No re-check per frame.

**Silent failure modes:**

5. **Hook client socket errors exit non-zero but hook.sh translates them to deny** (`permission-hook-client.ts`, `permission-hook.sh`):
   - Socket errors (connect failed, frame parse failure) are caught and exit non-zero. The shell wrapper treats any non-zero as a timeout/error and exits 2 (deny).
   - User sees "permission relay timed out" even if the socket error was "dispatcher not running" or "secret mismatch". Root cause buried in stderr.
   - Recommendation: structured error codes so logs can distinguish socket vs. timeout vs. verdict errors.

6. **Subagent spawn failures not retried** (`subagent-cache.ts`):
   - If `spawnFn()` returns null (no agent bound to chat), dispatch fails with "subagent spawn skipped (no agent bound)". No fallback; the message is lost from the subagent's perspective.

7. **Frame queue predicate mismatch silences frames** (`subagent-process.ts`):
   - If a frame arrives that doesn't match the current predicate, it is pushed back onto `frameQueue` and the waiter is re-added. However, if the waiter times out while the frame is buffered, the frame is orphaned forever.
   - No garbage collection of orphaned frames or waiters; `frameQueue` can grow unbounded.

8. **Message router doesn't inform unauthorized senders** (`message-router.ts`):
   - Unauthorized senders (paired chat but not owner) are silently ignored with a log line. No feedback to the user.
   - Contrasts with unpaired chats, which trigger the pairing flow.

9. **Reaction dispatch fires asynchronously and failures are swallowed** (`activity-reactions.ts`):
   - `reactForTool()` is fire-and-forget; if the DC reaction RPC fails, the turn continues unaffected.

10. **Rate limiter doesn't inform user of rate-limit hit** (`rate-limit.ts`, `server.ts`):
    - Returns boolean; dispatcher logs and drops the tool call, but no message to Claude saying "rate limit exceeded, tool denied."
    - Recommendation: return a structured error.

**Orphaned code or inconsistencies:**

11. **`suppressUserClaudeMd` deferred to Phase 2** (`subagent-process.ts`):
    - Flag is parsed and logged but ignored. No-op. Needs a `--no-user-claude-md` or similar flag in Claude Code.

12. **Reaction router buffers but does not persist** (`reaction-router.ts`):
    - Buffered reactions are lost if the dispatcher crashes between buffer and flush.

13. **Orphan cleanup skips live subagents owned by sibling dispatchers** (`orphan-cleanup.ts`):
    - Two dispatchers starting concurrently will each skip the other's subagents (ppid != 1). If the sibling crashes after killing children, the new dispatcher will see ppid=init and kill them. No PID lockfile prevents this race.

14. **Pre-warm entry point not discoverable** (`subagent-cache.ts`):
    - `cache.prewarm(chatId)` is public but may not be exposed by server.ts; dead code if no caller.

**Configuration inconsistencies:**

15. **`DEFAULT_GATED_TOOLS` hard-coded** (`hook-config.ts`):
    - Default is `['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch']`. No env/config override.

16. **`KNOWN_MCP_SERVERS` is a fixed map** (`subagent-process.ts`):
    - MCP servers are hard-coded. Per-subagent `allowedMcpServers` can restrict but cannot expand.

**Missing observability:**

17. **No histogram for turn latency** (`subagent-process.ts`):
    - Turn times are logged (`durationMs` in `resultFrame`) but not exported or aggregated. No p50/p99 metrics.

18. **No metrics for cache hit/miss ratio** (`subagent-cache.ts`):
    - `hasLive()` is not instrumented. No visibility into cold-spawn frequency.

19. **Queue drop callback is best-effort** (`subagent-cache.ts`):
    - `onQueueDrop()` may throw and is caught silently.
