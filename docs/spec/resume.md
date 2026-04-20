# Session Resume / Teleport

## Feature: Session resume / teleport

### Intended behavior

**DC → terminal**: User selects "Send chat to terminal" in agent-setup app. App builds a command via `buildResumeCommand()`, sends cleanup notifications, evicts the subagent, moves or deletes scheduled jobs, and posts the terminal command (`cd <cwd> && claude --resume <uuid>`). The user copies and pastes it after the turn ends. The DC chat is left; the binding is deleted; the session `.jsonl` remains on disk and can be resumed independently from the terminal.

**Terminal → DC**: User selects "Resume a session in DC" in agent-setup app. App lists available sessions from `~/.claude/projects/*/*.jsonl` via `listResumeCandidates()`, filters out live (open-file-handles) and already-bound sessions, and presents sorted by mtime. User picks a session; app calls `resumeAttachToChat()`, creates a new DC chat, binds it to the session's original or inferred agent, and imports the session UUID. A background LLM turn generates a summary and chat title.

### State machine / transitions

**Session states** (from resume perspective):
- **Terminal-origin**: `.jsonl` created by `claude` CLI in `~/.claude/projects/<cwd-hash>/`. Not bound to any DC chat initially.
- **DC-origin**: `.jsonl` created when a DC chat spawns a subagent. Initially DC-bound; may become orphaned if the binding is deleted without cleanup.
- **DC-origin-orphan**: Session UUID points to a `.jsonl` on disk; binding has been deleted or chat was left. Session-agents index still maps sessionId → agentId for recovery.
- **Currently-bound**: A binding record exists mapping chatId → sessionId + workingDir.
- **Live (held open)**: Process has the `.jsonl` file open (detected via `fuser`). Single-writer invariant — only one side (DC subagent or terminal Claude) may access the session at a time.
- **Cold**: File exists but no process is accessing it.

**Transitions**:
- **Terminal spawns session**: Creates cold terminal-origin `.jsonl` in project-hash dir.
- **DC spawns for new chat**: Creates cold DC-origin `.jsonl`, records sessionId in binding.
- **DC teleports out**: Subagent evicted, binding deleted, scheduled jobs moved/deleted, chat left → terminal-origin (orphaned binding deleted, sessionId freed for terminal attach).
- **Terminal joins DC chat**: `attachSessionToChat()` reads origin cwd from `.jsonl`, creates binding with sessionId + workingDir → currently-bound DC-origin.
- **DC resuming terminal session**: Terminal-origin becomes currently-bound via attach.
- **Session locked by live process**: Excluded from resume list; re-checked at attach time with `isSessionLive()` as a guard against TOCTOU race.

### Persisted state

**`workingDir` field on binding** (`~/.claude/channels/deltachat/bindings/<chatId>.json`):
- Semantics: The directory the subagent is spawned in, and emitted by `buildResumeCommand()` as the `cd` target.
- Write-once-ness: Set on first subagent spawn (to dispatcher's `process.cwd()` for DC-native chats, or to origin cwd for terminal-origin sessions via `attachSessionToChat()`). Persisted atomically alongside sessionId. Once set, never changes — ensures `claude --resume <uuid>` finds the `.jsonl` on first try without needing to hash-search.
- Fallback: Older bindings (pre-`workingDir`) use PLUGIN_DIR as cwd; modern code prefers lossless `readSessionCwd()` from `.jsonl` header over lossy reverse-hash.

**Session-agents index** (`~/.claude/channels/deltachat/session-agents.json`):
- Maps sessionId → agentId (string → string JSON object).
- Written: Every time `bindings.saveBinding()` stores a binding with both sessionId and agentId. Invoked on agent creation, binding updates, and resume-attach.
- Consulted: By `resume_attach` handler to recover the original agent when pulling a terminal session into a new DC chat. Survives binding deletion — orphan sessions can still find their agent on re-import.
- Semantics: Single-writer per session (dispatcher only). In-memory cache loaded once and persisted on write.

**Claude's `.jsonl` files** (`~/.claude/projects/<cwd-hash>/<sessionId>.jsonl`):
- Read by `resume.ts` helpers: `readSessionMeta()` (head + tail scan for summary, custom-title, message-count estimate), `readSessionCwd()` (first ~16 KB for original cwd), `readRecentTurns()` (tail ~32 KB for LLM summary generation).
- Never written by this plugin — Claude's session store is read-only. Plugin only controls the binding (which sessionId is paired).
- Lossless cwd extraction: Inline JSON field on user/assistant turns beats project-hash reverse (lossy when paths contain `-`).

**Scheduled jobs under a session** (`~/.claude/channels/deltachat/schedules/<chatId>-<jobId>.json`):
- On teleport-out: `scheduleStore.moveForChat(fromChatId, toChatId)` renames every job file from `<fromChatId>-*.json` to `<toChatId>-*.json` and rewrites the `chatId` field inside. Transactional — throws before touching disk if a jobId collision would occur.
- Alternative: `deleteForChat()` removes all jobs if the user doesn't opt to preserve them.
- Semantics: Jobs are bound to a chatId, not a sessionId. Teleport-out must move them manually to preserve scheduled behavior on the receiving chat.

### Observable surface

**`dc_resume_in_terminal` tool**:
- Input: `chat_id` (string, required) — the DC chat to resume.
- Output: Success case: returns `{ content: [{ type: 'text', text: 'Resume command already sent...' }] }`. Command is posted directly to the chat via `client.send()` to guarantee visibility. Subagent should NOT echo the tool result.
- Async cleanup (5 s timeout): Goodbye message, evict subagent, move/delete jobs, leave chat, delete binding.
- Error cases: Missing `chat_id`, unauthorized chat, no binding, session file deleted → error messages returned to subagent.

**Agent-setup resume screens** (inputs / outputs, UI not covered):
- `resume_list_request`: Subagent requests list of candidates. Server responds with `resume_list` payload: `{ type: 'resume_list', candidates: Candidate[], requestId, version, ... }`.
- `Candidate` fields: `sessionId`, `sessionPath`, `cwd`, `mtimeMs`, `summary`, `sessionName`, `messageCount`.
- `teleport_out_list_request`: App requests list of paired chats with resume info. Server responds with `teleport_out_list` payload: `{ type: 'teleport_out_list', chats: TeleportOutChat[], ... }`.
- `TeleportOutChat` fields: `chatId`, `chatName`, `agentId`, `agentName`, `jobCount`, `isTrusted`, `isLive` (fuser check), `sessionId`, `workingDir`.
- `resume_attach`: User picks a session. Payload: `{ type: 'resume_attach', sessionId, requestId }`. Server responds with `resume_attach_ok` (new chat created) or `resume_attach_err` (session live, already bound, not found, etc.).
- `teleport_out_commit`: User confirms send-to-terminal with job disposition. Payload: `{ type: 'teleport_out_commit', chatId, jobDisposition, requestId }`. Server streams progress updates (`teleport_out_progress` with step/status/detail) then `teleport_out_done` or `teleport_out_error`.

**Terminal command string format**:
```
cd <workingDir> && claude --resume <sessionId> --name '<chatName>'
```
Shell-quoted chat name (optional) for session display. Command must be pasted after the turn ends (5 s grace period) to avoid file-lock contention with the DC subagent.

### Primary source files

| File | Purpose |
|------|---------|
| `plugin/resume.ts` | Core session UUID ↔ `.jsonl` mapping, `buildResumeCommand()`, `listResumeCandidates()`, `attachSessionToChat()`, `isSessionLive()`, fuser integration. |
| `plugin/bindings.ts` | Binding registry (chatId → sessionId, agentId, workingDir, createdAt), atomic save/load via temp+rename, orphan sweep. |
| `plugin/session-agents.ts` | Persistent sessionId → agentId reverse index for orphan recovery, in-memory cache with file-based persistence. |
| `plugin/dispatcher/schedule-store.ts` | Job file I/O, `moveForChat()` for teleport-out, `deleteForChat()` for cleanup. |
| `plugin/server.ts` | `dc_resume_in_terminal` tool registration and implementation, `cleanupChatState()` helper, subagent spawn with workingDir persistence. |
| `plugin/cleanup.ts` | `decideCleanup()` logic for detecting abandoned chats (bot removed or bot-alone), used by event handlers. |
| `plugin/apps/agent-setup-app.ts` | `buildTeleportOutList()`, resume flow handlers (`resume_list_request`, `resume_attach`, `teleport_out_list_request`, `teleport_out_commit`), orphan-chat sweep via `sweepDeadChats()`. |

### Audit notes

**Known constraints**:
- **Single-writer invariant**: One `.jsonl` file, one live process at a time. Enforced by `fuser` checks at attach time (terminal-to-DC) and resume list exclusion (DC-to-terminal). If both sides hold the file simultaneously, session state corrupts.
- **Same-machine only**: Resume does not sync sessions across devices. Requires local `~/.claude/projects/` and `~/.claude/channels/` dirs.
- **Binding write-once-ness**: `workingDir` never changes after first assignment. If dispatcher relaunches from a different dir, old bindings keep their cached dir; new DC chats adopt the new launcher cwd. Mixed dirs in the same session can cause hash mismatches.

**Races**:
- **Teleport-out mid-turn**: Subagent is evicted 5 s after tool returns. If user sends another message before that grace period, new subagent spins up and races the old session lock with the terminal. Guard: User told to wait for turn to end before pasting.
- **Attach with live session**: User picks a session that goes live between list and attach. Guard: `isSessionLive()` re-checks at attach time; returns error if session is open (race-aware but not race-free).
- **Job collision on move**: If target chat already has a jobId from the source chat (extremely rare), `moveForChat()` throws before writing; admin intervention needed to resolve.

**Orphan accumulation**:
- **Orphan bindings**: Occur when a session is teleported out (binding deleted) but `session-agents.json` entry persists. Sweep at dispatcher startup via `bindings.sweepOrphans()` removes bindings whose chatId is not in the access list.
- **Stale session-agents entries**: No automatic cleanup. If a binding is deleted before the reverse-index entry is written (e.g., crash mid-write), the index entry leaks. Harmless but accumulates over time.
- **Orphan DC-origin sessions**: A session `.jsonl` on disk whose binding was deleted. Included in resume list so user can recover. Identified by absence of binding but presence of `.jsonl` + mtime within cutoff window.

**Observable failures**:
- `listResumeCandidates()`: Excludes sessions already bound (checked against all bindings), already held open (fuser returns 0), older than 5 days (default cutoff). Lossy `cwdFromProjectHash()` if old-style project hash dir exists; no warning.
- `isSessionLive()`: Returns false on fuser error (timeout 3 s, falls through to false if binary missing). Silent non-fatal fallback.
- `buildResumeCommand()`: Returns `kind: 'fresh'` fallback if binding exists but sessionId or `.jsonl` is missing — emit `cd ... && claude` instead of `--resume`.
- `attachSessionToChat()`: Throws if sessionId already bound to a different chat (prevents double-bind) or sessionId not found on disk.

**Key file:line references**:
- `resume.ts` — `buildResumeCommand()` main logic, `isSessionLive()` via fuser, `listResumeCandidates()` scanning + filtering, `attachSessionToChat()` binding update with cwd recovery.
- `bindings.ts` — `saveBinding()` atomic write + session-agents update.
- `session-agents.ts` — `setAgentForSession()` persist.
- `schedule-store.ts` — `moveForChat()` transactional job migration.
- `server.ts` — `dc_resume_in_terminal` tool impl, post-turn cleanup via `setTimeout`; `cleanupChatState()` teardown helper called by resume-out and unpair.
- `agent-setup-app.ts` — WebXDC resume and teleport handlers (list, attach, commit).
