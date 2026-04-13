# MCP Server Toggles — Design Spec

**Date:** 2026-04-12
**Status:** Draft
**Depends on:** Per-agent tool access (issue #16, merged)

## Problem

Issue #16 added per-agent tool access for built-in tools and DC tools. But
subagents also inherit the user's global MCP servers (Gmail, Calendar, Slack,
Telegram plugin, etc.) via Claude Code's `--mcp-config` merge behavior. These
servers are loaded but **blocked** because `--allowedTools` only includes
`mcp__dc` + built-in tools. There's no way for the user to selectively enable
global MCP servers per agent.

## Design Decisions

1. **MCP servers are all-or-nothing toggles** — not per-tool checkboxes. A
   Gmail server exposes ~10 tools; toggling them individually adds UI clutter
   with no real benefit. You either want the agent to have Gmail or you don't.

2. **DC tools also become all-or-nothing** — same reasoning. The DC tools
   group (dc_send_file, dc_chat_history, dc_react, etc.) is already a logical
   unit; fine-grained DC tool selection isn't useful in practice.

3. **Built-in tools stay fine-grained** — per-tool checkboxes. Disabling
   Bash but keeping Read/Edit is a real use case.

4. **Schema change:** Replace `allowedMcpTools: string[]` (individual tool
   names) with `allowedMcpServers: string[] | null` (server prefixes).
   `null`/absent = all servers allowed. `[]` = no MCP servers. Explicit
   array = only those server prefixes in `--allowedTools`.

5. **Discovery:** Global MCP servers are discovered at runtime by reading the
   dispatcher's own tool list from the MCP server object. The dispatcher's
   Claude Code session loads all global MCP servers; we can enumerate them
   from the registered tool names. Alternatively, maintain a static registry
   seeded from `settings.json` `enabledPlugins` + known `claude.ai` managed
   servers. **Chosen approach:** enumerate from the MCP server's own
   `server.listTools()` response or from the deferred tool names visible to
   the dispatcher. Simplest v1: pass the list of known MCP server prefixes
   as a startup config (read from env or a config file), since the dispatcher
   can't easily introspect Claude Code's internal MCP state.

   **Practical v1:** Hardcode a `KNOWN_MCP_SERVERS` map in `server.ts` that
   lists the server prefixes and display names for servers the plugin knows
   about. This is easy to extend and doesn't require runtime introspection.
   The map covers:
   - `dc` — DC Tools (always present)
   - `claude_ai_Gmail` — Gmail
   - `claude_ai_Google_Calendar` — Google Calendar
   - `claude_ai_Slack` — Slack
   - `claude_ai_Notion` — Notion
   - `claude_ai_Asana` — Asana
   - `plugin_telegram_telegram` — Telegram

   The agent-setup card shows only servers that are actually available (have
   at least one tool registered). So if the user hasn't connected Gmail, the
   toggle doesn't appear.

## Data Model

### Agent definition (YAML)

```yaml
# Before (issue #16):
allowedMcpTools: [dc_send_file, dc_chat_history]  # per-tool

# After:
allowedMcpServers: [dc, claude_ai_Gmail]  # per-server prefix
# null/absent = all servers allowed (default)
# [] = no MCP servers at all
```

`allowedMcpTools` is **removed** from the schema. Migration: on load, if
`allowedMcpTools` is present and `allowedMcpServers` is absent, derive
`allowedMcpServers` from the tool name prefixes (e.g., `dc_send_file` →
`dc`). Since issue #16 just shipped and no agents have been created with
`allowedMcpTools` yet in practice, this is mostly defensive.

### `--allowedTools` at spawn time

```
--allowedTools "Bash Read Edit Write ... mcp__dc mcp__claude_ai_Gmail"
```

Each enabled MCP server adds its prefix (`mcp__<server>`) to the allowedTools
list. Claude Code's `--allowedTools` supports prefix matching — `mcp__dc`
allows all tools under the `dc` MCP server.

## UI Changes

The tool picker in agent-setup.html currently has two groups:
- **Built-in Tools** — per-tool checkboxes (unchanged)
- **DC Tools** — per-tool checkboxes (changes to single toggle)

New layout:
- **Built-in Tools** — collapsible, per-tool checkboxes (unchanged)
- **MCP Servers** — collapsible section with one toggle per server:
  - `DC Tools (12 tools)` — on/off
  - `Gmail (6 tools)` — on/off
  - `Google Calendar (8 tools)` — on/off
  - `Telegram (4 tools)` — on/off
  - etc.

Each row shows server display name + tool count. Collapsed by default.
"Select all / Deselect all" at the top of the section.

## Payload Changes

### Server → WebXDC (`availableToolsPayload`)

```typescript
// Before:
{ availableBuiltinTools: [...], availableMcpTools: [...] }

// After:
{
  availableBuiltinTools: [...],
  availableMcpServers: [
    { prefix: 'dc', label: 'DC Tools', toolCount: 12 },
    { prefix: 'claude_ai_Gmail', label: 'Gmail', toolCount: 6 },
    ...
  ]
}
```

### WebXDC → Server (`collectToolPickerState`)

```typescript
// Before:
{ allowedBuiltinTools: null | string[], allowedMcpTools: null | string[] }

// After:
{ allowedBuiltinTools: null | string[], allowedMcpServers: null | string[] }
```

## Enforcement

In `subagent-process.ts`, change line 163 from:

```typescript
['mcp__dc', ...builtinTools].join(' ')
```

To:

```typescript
[...mcpPrefixes, ...builtinTools].join(' ')
```

Where `mcpPrefixes` is derived from the agent's `allowedMcpServers`:
- `null`/absent → all known server prefixes (current behavior + new ones)
- `[]` → no MCP prefixes at all
- Explicit list → `mcp__<prefix>` for each

The DC tool manifest filtering in `server.ts` (lines 209-211) changes from
per-tool filtering to a simple on/off check: if `dc` is in
`allowedMcpServers`, include all DC tools in the manifest; if not, include
none.

## Backward Compatibility

- Existing agents with no `allowedMcpTools` or `allowedMcpServers`: unchanged
  behavior (all tools allowed).
- Existing agents with `allowedMcpTools` array: migrated on load to
  `allowedMcpServers` by extracting unique prefixes. Field is rewritten on
  next save.
- `allowedMcpTools` removed from schema validation (with `.passthrough()` or
  explicit strip).
