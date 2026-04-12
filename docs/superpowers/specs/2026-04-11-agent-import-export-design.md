# Agent Import/Export Design

**Issue:** #15 — Import and export agent definitions  
**Date:** 2026-04-11  
**Branch:** v0.9.5

## Goal

Let users import agent definitions by sending `.yaml` files into a DC chat, and export agents via the agent-setup WebXDC card. No subagent/LLM involvement — both operations are deterministic dispatcher logic. Round-trip compatible with Claude Managed Agents API YAML format.

## Architecture

Import and export are handled entirely by the dispatcher — no MCP tools, no subagent turns, no model tokens. Import is triggered by file-attachment detection in the message router. Export is triggered by a new WebXDC update type in the agent-setup card. Both use the existing `agents.ts` API (`saveAgent`, `getAgent`, `synthesizeAgentId`) for persistence.

## Import Flow

1. Message router receives an incoming message in a paired chat.
2. If the message has a file attachment with a `.yaml` or `.yml` extension:
   a. Check file size — reject if > 256 KB.
   b. Download the attachment via DC RPC.
   c. Parse YAML and validate against `AgentDefSchema`.
   d. On validation failure: send a concise error message (first Zod error) back to the chat. Pass the message through to the subagent so it can still respond to any accompanying text.
   e. On success:
      - If the definition has no `id` field, synthesize one from `name` via `synthesizeAgentId()`.
      - If the `id` collides with an existing agent, auto-suffix (`marketing-agent-2`).
      - Save via `saveAgent()`.
      - Send confirmation: "Imported agent '<name>' (id: <id>). To create a chat with it, use the agent setup card."

### Import detection point

The attachment check happens in `message-router.ts` (or in the `runSubagentTurn` wrapper in `server.ts`) before the message is dispatched to the subagent. If the attachment is a valid agent YAML, we intercept and handle it. The message is NOT forwarded to the subagent — the import confirmation serves as the full response.

If the YAML is invalid, we still forward the message to the subagent (the user may have sent the file as context for a conversation).

### What gets imported

The full `AgentDef` as defined by `AgentDefSchema` — all fields including `metadata` with `x-dc-*` extensions (`x-dc-skipPermissions`, `x-dc-iconMirror`). Nothing is stripped.

### ID handling

- If the imported YAML has no `id` field: synthesize from `name` via `synthesizeAgentId()` (slugify + collision suffix).
- If the imported YAML has an `id` field and it doesn't collide: use it as-is.
- If the imported YAML has an `id` field and it collides: append `-2`, `-3`, etc. to the provided `id` until unique. This is a simpler loop than `synthesizeAgentId` (no slugification needed — the id is already a valid slug from the source system).
- The confirmation message always mentions the final assigned ID so the user knows what happened.

## Export Flow

1. Agent-setup WebXDC card shows an "Export" button for each agent in the list view.
2. User taps "Export" — card sends a WebXDC update:
   ```json
   {
     "type": "export",
     "agentId": "marketing-agent",
     "senderAddr": "<owner addr>"
   }
   ```
3. `onWebXDCUpdate` handler in `agent-setup-app.ts` catches the `export` type.
4. Reads the agent definition via `getAgent(agentId)`.
5. If agent no longer exists: sends an error update back to the card.
6. Serializes the full `AgentDef` to YAML.
7. Writes to a temp file named `<agentId>.yaml`.
8. Sends the file to the chat as a DC file attachment.
9. Cleans up the temp file.

### What gets exported

The full agent definition as-is — all fields including `metadata` with `x-dc-*` keys. No stripping. Non-DC tools will ignore unknown metadata fields.

### File naming

Exported file: `<agentId>.yaml`. This matches the on-disk storage convention and round-trips naturally on import.

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Non-agent YAML (random `.yaml` file) | Validation fails; send concise error; forward message to subagent |
| Missing `id` field | Synthesize from `name` via `synthesizeAgentId()` |
| Missing `name` field | Zod validation fails (name is required, min 1 char) |
| ID collision | Auto-suffix: `marketing-agent-2`, `marketing-agent-3`, etc. |
| Large file (> 256 KB) | Reject before parsing; send size error |
| Binary file with `.yaml` extension | YAML parse fails; caught by try/catch |
| Export of deleted agent | Error update back to WebXDC card |
| Multiple `.yaml` files in one message | DC delivers one attachment per message; not applicable |

## Testing

- **Unit tests for import logic:** Parse + validate + save with various inputs (valid, invalid, no-id, collision). Pure function tests against `agents.ts` API.
- **Unit tests for export logic:** Read agent + serialize + verify YAML output.
- **Round-trip test:** Export an agent, re-import the exported file, compare definitions (should be identical except possibly the ID if there was a collision).
- **agent-setup HTML:** Verify "Export" button sends correct WebXDC update payload with `senderAddr`.
- **`webxdc-sender-addr.test.ts`:** Existing test will auto-verify the new `sendUpdate` call includes `senderAddr`.

## Files to Modify

- `plugin/dispatcher/message-router.ts` or `plugin/server.ts` — attachment detection + import handler
- `plugin/agents.ts` — possible new helper: `importAgentFromYaml(yamlString): {agent: AgentDef, collision: boolean}`
- `plugin/apps/agent-setup-app.ts` — handle `export` WebXDC update type
- `plugin/webxdc/agent-setup.html` — add "Export" button to agent list, send `export` update
- `plugin/agent-setup.ts` — bump `APP_VERSION` in the HTML

## Non-Goals

- No `dc_import_agent` / `dc_export_agent` MCP tools (no subagent involvement needed).
- No bulk import/export (one agent per file).
- No stripping of `x-dc-*` metadata on export.
- No auto-bind on import (user uses agent-setup card to bind).
