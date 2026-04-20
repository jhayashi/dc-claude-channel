# Skip-Permissions + Audit Log

## Feature: Skip-permissions + audit log

### Intended behavior

When a chat is bound to an agent whose metadata includes `x-dc-skipPermissions: true`, the dispatcher auto-approves all tool calls made by that subagent and appends an audit entry instead of showing the WebXDC permission card. This enables unattended execution while maintaining a reviewable log of all auto-approved actions.

Each tool call appended to the audit log includes the timestamp, agent ID, tool name, and a JSON snapshot of the input (truncated at 1000 characters to avoid bloat). The audit file is stored per-chat in markdown format, rendered by the file-reviewer WebXDC app via `dc_show_audit` tool.

### State machine / transitions

- **Check skip-permissions flag** — On permission request, `tryAutoApprove()` queries the agent metadata for `x-dc-skipPermissions` (via `getSkipPermissions()`).
- **No flag** — Returns null; caller falls through to normal WebXDC permission card.
- **Flag present** — Append audit entry via `audit.appendEntry()`, then immediately return `{kind: 'permissionVerdict', id, verdict: 'allow'}`.
- **Audit write** — `appendEntry()` creates audit directory if needed, checks if file exists. If first entry, prepend header (chat ID + description). Append rendered entry (timestamp, agent ID, tool name, JSON input). Append-only, no rotation.
- **User review** — User calls `dc_show_audit(chat_id)` to fetch the audit file and render it in the file-reviewer app.

### Persisted state

**Audit file location:** `~/.claude/channels/deltachat/audit/<chatId>.md` (one per chat).

**Format:** Markdown, append-only.
```markdown
# Audit log for chat <chatId>

Auto-approved tool calls for agents running in skip-permissions mode.

## <ISO 8601 timestamp> — `<tool_name>`
_agent: <agentId>_

```json
{...input JSON, max 1000 chars, truncated with … if longer...}
```

## <next timestamp> — `<tool_name>`
...
```

**Header:** Written once on first append. Reused on subsequent appends (checked via `existsSync`).

**Input truncation:** `MAX_INPUT_CHARS = 1000`. Inputs longer than this are `JSON.stringify`'d, truncated to first 1000 chars, and appended with `…`.

### Observable surface

**Agent metadata flag:** `x-dc-skipPermissions: true` (boolean) in agent definition's metadata bag.

**Metadata read:** `getSkipPermissions(agent)` returns boolean (true if flag is set, false otherwise).

**Tool:** `dc_show_audit(chat_id)` — Sends the audit file via file-reviewer. Returns success message or error if file does not exist / file-reviewer fails.

**Audit entry interface:** `{ chatId, agentId, tool, input, timestamp: ISO 8601 }`.

**Directory override (test):** `setAuditDir(dir)` for tests.

**File-path queries:**
- `auditFilePath(chatId)` — Always returns path (whether or not file exists).
- `auditFilePathIfExists(chatId)` — Returns path only if file exists, else null.

### Primary source files

- `plugin/dispatcher/skip-permissions.ts` — `tryAutoApprove()` entry point; checks flag, appends audit, returns verdict.
- `plugin/audit.ts` — Audit log management: `appendEntry`, `renderEntry`, `auditFilePath`, header logic.
- `plugin/agents.ts` — `getSkipPermissions()` helper.
- `plugin/server.ts` — Integration: `tryAutoApprove()` called on permission requests (socket-server glue).
- `plugin/test/skip-permissions.test.ts` — Unit tests with injected `now()` for deterministic timestamps.

### Audit notes

Audit entries are created only for **allowed** tool calls. Denied calls (user rejects permission card, or tool is not in the agent's allowlist) do not appear in the audit log — they surface as `permission_denial` frames and are not auto-executed.

The audit log is **append-only with no cleanup**: it grows indefinitely unless manually deleted. Long-running agents in skip-permissions mode may accumulate large audit files. Consider periodic archival/rotation if needed.

**Interaction with tool allowlisting:** If both skip-permissions and per-agent tool restrictions are active, denied tools are filtered by the harness before the permission handler runs. Only allowed tools reach the auto-approve check, so the audit log contains only the subset of tools the agent is permitted to use.

**Privacy:** The input parameter snapshot is stored in plaintext. Sensitive data (API keys, passwords, PII) may appear in the audit log if passed as tool input. No encryption or redaction is applied.
