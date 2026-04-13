# Per-Agent Tool/MCP Access (Issue #16)

## Goal

Allow each agent definition to restrict which built-in tools and MCP tools its subagent can use. Configured via collapsible tool picker in the agent-setup WebXDC card. Enforced at spawn time only.

## Context

Today every subagent gets the same hardcoded set of built-in tools (`Bash`, `Read`, `Edit`, `Write`, `Grep`, `Glob`, `WebFetch`, `WebSearch`, etc.) and the full DC MCP tool manifest. The `tools` field on `AgentDef` exists but is a no-op placeholder for forward compat with the Claude Managed Agents API.

This feature adds per-agent allowlists for both tool categories, enforced through existing mechanisms: the `--allowedTools` CLI flag for built-ins and manifest filtering for MCP tools.

## Data Model

### New fields on `AgentDef` (agents.ts)

Two optional nullable fields added to `AgentDefSchema`:

```typescript
allowedBuiltinTools: z.array(z.string()).nullable().optional()
allowedMcpTools: z.array(z.string()).nullable().optional()
```

Semantics:
- `null` or absent → all tools allowed (default for new agents)
- `[]` (empty array) → no tools of that category allowed
- `['Read', 'Glob', 'Grep']` → only those specific tools allowed

The existing `tools: []` field is unchanged — it remains a forward-compat no-op.

### YAML representation

```yaml
id: marketing-agent
name: Marketing Agent
model: claude-sonnet-4-6
system: |
  You are a marketing specialist...
tools: []
allowedBuiltinTools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
allowedMcpTools:
  - reply
  - dc_react
  - dc_chat_history
  - dc_send_file
```

When all tools are enabled (the default), the fields are omitted from YAML entirely rather than writing `allowedBuiltinTools: null`.

## Enforcement

Spawn-time only. No runtime enforcement needed — restricted tools are invisible to the subagent.

### Built-in tools

In `subagent-process.ts`, `buildSubagentArgs()` currently hardcodes the `--allowedTools` list. Change: if `agent.allowedBuiltinTools` is non-null, use that list instead. `mcp__dc` is always included regardless (MCP tool filtering happens via the manifest).

```typescript
const ALL_BUILTIN_TOOLS = [
  'Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob',
  'WebFetch', 'WebSearch', 'NotebookEdit', 'Task', 'TaskOutput',
  'TaskStop', 'TodoWrite', 'Skill', 'ToolSearch', 'AskUserQuestion',
  'LSP', 'EnterPlanMode', 'ExitPlanMode', 'EnterWorktree', 'ExitWorktree',
]

const builtinTools = agent.allowedBuiltinTools ?? ALL_BUILTIN_TOOLS
const allowedTools = ['mcp__dc', ...builtinTools]
args.push('--allowedTools', allowedTools.join(' '))
```

The `ALL_BUILTIN_TOOLS` constant is the single source of truth for the full set. It is also sent to the agent-setup card for rendering the built-in tools group.

### MCP tools

In `server.ts`, `spawnSubagentForChat()` builds `toolDefs` from core tools and app tools (already filtered by `SUBAGENT_TOOL_BLOCKLIST`). Change: if `agent.allowedMcpTools` is non-null, filter `toolDefs` to only include tools whose name is in the allowlist before passing to `generateHookConfig()`.

```typescript
let filteredToolDefs = toolDefs
if (agent.allowedMcpTools != null) {
  filteredToolDefs = toolDefs.filter(t => agent.allowedMcpTools!.includes(t.name))
}
```

The tools-proxy reads the manifest file and exposes exactly what's in it — no further changes needed downstream.

## UI: Collapsible Tool Picker

### Placement

Added below the "Skip permissions" checkbox in both the Create (step2) and Edit (step3) forms in `agent-setup.html`.

### Layout

```
Allowed Tools
┌─────────────────────────────────┐
│ ▼ Built-in Tools        7 / 10 │
│ ┌─────────────────────────────┐ │
│ │ [Select all]                │ │
│ │ ☑ Read    — Read files      │ │
│ │ ☑ Write   — Create files    │ │
│ │ ☑ Edit    — Modify files    │ │
│ │ ☐ Bash    — Run commands    │ │
│ │ ☑ Glob    — Find files      │ │
│ │ ☑ Grep    — Search content  │ │
│ │ ...                         │ │
│ └─────────────────────────────┘ │
├─────────────────────────────────┤
│ ▶ DC Tools              5 / 5 ✓│
└─────────────────────────────────┘
```

### Behavior

- **Initial state:** Both groups collapsed, showing counter "N / N ✓" (all enabled by default).
- **Tap group header:** Toggles expand/collapse of the tool list within that group.
- **Select all / Deselect all:** Per-group toggle link at the top of the expanded list.
- **Each tool row:** Checkbox + tool name + short description text.
- **Counter:** Updates live as checkboxes change. Green checkmark shown when all tools in the group are enabled.

### Data flow

#### Server → Card (init payload)

Two new fields on the `init` and `editAgent` payloads:

```typescript
availableBuiltinTools: Array<{ name: string; description: string }>
availableMcpTools: Array<{ name: string; description: string }>
```

Built-in tool list is the `ALL_BUILTIN_TOOLS` constant with descriptions. MCP tool list comes from the same `toolDefs` array used for the manifest (post-blocklist filtering).

For `editAgent`, the payload also includes the agent's current `allowedBuiltinTools` and `allowedMcpTools` values (null means all enabled).

#### Card → Server (create/save payload)

The create and save payloads include:

```typescript
allowedBuiltinTools: string[] | null  // null = all enabled
allowedMcpTools: string[] | null      // null = all enabled
```

When all checkboxes in a group are checked, the card sends `null` for that group (meaning "all tools" — avoids breaking when new tools are added later).

#### Server handling

On create: write fields to agent YAML via `createAgent()` / `updateAgent()`.
On edit/save: update fields on existing agent YAML.

## Edge Cases

### Agent with no tools
Both arrays set to `[]`. The subagent spawns with `--allowedTools mcp__dc` and an empty MCP manifest. Claude can still chat but cannot use any tools. Valid configuration.

### New tool added to the system
Agents with `null` (unconfigured) automatically get new tools. Agents with explicit allowlists do not — the user must re-edit the agent to add the new tool. This is intentional: explicit configuration should not silently change.

### Import/export
`allowedBuiltinTools` and `allowedMcpTools` are part of the agent YAML and export/import naturally. If an imported agent references tools that don't exist on the target host, those entries are silently ignored during manifest filtering (no match = not included).

### Running subagent after edit
Restrictions take effect on next spawn (after idle timeout, LRU eviction, or new chat). The current session keeps its original tools. This matches how model and system prompt changes already work.

### Backward compatibility
Existing agent YAMLs without these fields continue working — `null`/absent means "all tools allowed." No migration needed.

## Files Changed

- `plugin/agents.ts` — Add `allowedBuiltinTools` and `allowedMcpTools` to schema, getters/setters
- `plugin/dispatcher/subagent-process.ts` — Read agent's `allowedBuiltinTools` and filter `--allowedTools` arg; export `ALL_BUILTIN_TOOLS` constant
- `plugin/server.ts` — Filter `toolDefs` by `allowedMcpTools` before passing to `generateHookConfig()`; include available tools in agent-setup init/edit payloads
- `plugin/webxdc/agent-setup.html` — Collapsible tool picker UI in create and edit forms
- `plugin/apps/agent-setup-app.ts` — Pass available tools in init/edit payloads, handle new fields on create/save
