# Per-Agent Tool Allowlisting

## Feature: Per-agent tool allowlisting

### Intended behavior

Each agent definition can restrict which built-in tools and MCP servers its subagent is allowed to use. Built-in tools (Bash, Read, Edit, Grep, LSP, etc.) have per-tool granularity; MCP servers (Gmail, Google Calendar, Slack, Notion, Asana, Telegram, DC Tools) are all-or-nothing toggles per server prefix.

When an agent is spawned, the allowlist is encoded in the `--allowedTools` CLI flag passed to the `claude` child process. Restrictions are enforced by the Claude Code harness at tool-invocation time — denied tools return `permission_denial` frames rather than executing.

If `allowedBuiltinTools` or `allowedMcpServers` are `null` or absent from the agent definition, all tools/servers are allowed (permissive default). An empty array `[]` denies all access to that category.

### State machine / transitions

- **Agent definition** — YAML file on disk includes optional `allowedBuiltinTools: [...]` and `allowedMcpServers: [...]` arrays (nullable).
- **Validation** — Agent schema (Zod) accepts both fields as optional nullable arrays of strings.
- **Migration** — Legacy `allowedMcpTools` (per-tool names) is migrated to `allowedMcpServers` (per-server prefixes) on load via `migrateToolsToServers()`.
- **Subagent spawn** — `buildSubagentArgs()` constructs `--allowedTools` flag: space-separated list of tool names prefixed with `mcp__` for servers (e.g. `mcp__dc mcp__claude_ai_Gmail Bash Read`). Defaults: all builtin tools + all known server prefixes.
- **UI exposure** — Agent-setup WebXDC app queries available tools via `availableToolsPayload()`, which loads `ALL_BUILTIN_TOOLS` and `KNOWN_MCP_SERVERS`. The UI renders checkboxes for builtins and toggles for servers. User selection updates `agent.allowedBuiltinTools` / `agent.allowedMcpServers` before `saveAgent()`.
- **Enforcement** — Claude Code harness (hook-config / subagent-process) filters available tools at spawn time and rejects denied tool calls with `permission_denial`.

### Persisted state

**Agent definition:** `~/.claude/channels/deltachat/agents/<agentId>.yaml`

**Schema fields:**
```yaml
allowedBuiltinTools: [string] | null  # null/absent = all allowed
allowedMcpServers: [string] | null    # null/absent = all allowed
```

**Migration field (deprecated):**
```yaml
allowedMcpTools: [string] | null  # migrated → allowedMcpServers on read
```

### Observable surface

**Built-in tools constant:** `ALL_BUILTIN_TOOLS` (`plugin/dispatcher/subagent-process.ts`):
- Bash, Read, Edit, Write, Grep, Glob
- WebFetch, WebSearch, NotebookEdit
- Task, TaskOutput, TaskStop, TodoWrite
- Skill, ToolSearch
- AskUserQuestion, LSP
- EnterPlanMode, ExitPlanMode, EnterWorktree, ExitWorktree

**MCP servers constant:** `KNOWN_MCP_SERVERS` (`plugin/dispatcher/subagent-process.ts`):
```
dc                          → 'DC Tools'
claude_ai_Gmail             → 'Gmail'
claude_ai_Google_Calendar   → 'Google Calendar'
claude_ai_Slack             → 'Slack'
claude_ai_Notion            → 'Notion'
claude_ai_Asana             → 'Asana'
plugin_telegram_telegram    → 'Telegram'
```

**Tool descriptions:** `BUILTIN_TOOL_DESCRIPTIONS` (`subagent-process.ts`) — short text for each built-in tool, used by the UI.

**CLI flag format:** `--allowedTools "mcp__<prefix> <prefix> ... <builtin> <builtin> ..."`. If an MCP server prefix is passed but the server is not available, Claude Code silently ignores it (no error).

**Agent-setup UI:** `availableMcpServers` / `connectedMcpServers` split — "available" are all known servers; "connected" are those that have completed OAuth auth. UI shows toggles for available servers.

### Primary source files

- `plugin/agents.ts` — `AgentDefSchema` with `allowedBuiltinTools` / `allowedMcpServers` / legacy `allowedMcpTools`; `migrateToolsToServers()` migration logic.
- `plugin/dispatcher/subagent-process.ts` — `ALL_BUILTIN_TOOLS`, `BUILTIN_TOOL_DESCRIPTIONS`, `KNOWN_MCP_SERVERS` constants; `buildSubagentArgs()` CLI flag generation.
- `plugin/apps/agent-setup-app.ts` — `availableToolsPayload()`, UI rendering of tool picker.
- `plugin/server.ts` — `getAvailableMcpServers()`, `getConnectedMcpServers()` context methods.

### Audit notes

Tool allowlisting is a deployment-time constraint. It does not affect skip-permissions audit logging — if both allowlisting and skip-permissions are active, denied tools are filtered at the harness level before reaching the dispatcher, so they never generate audit entries. Allowed tools are auto-approved and audited normally.

The interaction is transparent: if a user restricts an agent's tools and enables skip-permissions, only the allowed subset can auto-execute. Tool denials still surface as `permission_denial` frames to the user, consistent with the normal flow.
