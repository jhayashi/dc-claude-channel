# MCP Server Toggles — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-tool MCP toggles with per-server all-or-nothing toggles, and expose global MCP servers (Gmail, Calendar, Slack, Telegram, etc.) in the agent tool picker.

**Architecture:** Add a `KNOWN_MCP_SERVERS` registry in `subagent-process.ts`, change the agent schema from `allowedMcpTools` (per-tool) to `allowedMcpServers` (per-server prefix), update `--allowedTools` to include enabled server prefixes, and change the WebXDC tool picker to show MCP servers as single toggles instead of per-tool checkboxes.

**Tech Stack:** TypeScript/Bun, Zod, WebXDC HTML/JS

---

### Task 1: Add KNOWN_MCP_SERVERS registry and update --allowedTools

**Files:**
- Modify: `plugin/dispatcher/subagent-process.ts:77-165`

- [ ] **Step 1: Write the failing test**

In `plugin/test/subagent-process.test.ts`, add tests for the new server-level behavior:

```typescript
describe('MCP server toggles', () => {
  it('includes all known MCP server prefixes when allowedMcpServers is null', () => {
    const { args } = buildSubagentArgs({
      ...baseOpts,
      mcpConfigPath: '/tmp/mcp.json',
      allowedMcpServers: null,
    })
    const idx = args.indexOf('--allowedTools')
    const val = args[idx + 1]
    expect(val).toContain('mcp__dc')
    expect(val).toContain('mcp__claude_ai_Gmail')
    expect(val).toContain('mcp__claude_ai_Google_Calendar')
    expect(val).toContain('mcp__plugin_telegram_telegram')
  })

  it('includes only specified server prefixes when allowedMcpServers is explicit', () => {
    const { args } = buildSubagentArgs({
      ...baseOpts,
      mcpConfigPath: '/tmp/mcp.json',
      allowedMcpServers: ['dc', 'claude_ai_Gmail'],
    })
    const idx = args.indexOf('--allowedTools')
    const val = args[idx + 1]
    expect(val).toContain('mcp__dc')
    expect(val).toContain('mcp__claude_ai_Gmail')
    expect(val).not.toContain('mcp__claude_ai_Google_Calendar')
    expect(val).not.toContain('mcp__plugin_telegram_telegram')
  })

  it('includes no MCP prefixes when allowedMcpServers is empty array', () => {
    const { args } = buildSubagentArgs({
      ...baseOpts,
      mcpConfigPath: '/tmp/mcp.json',
      allowedMcpServers: [],
    })
    const idx = args.indexOf('--allowedTools')
    const val = args[idx + 1]
    expect(val).not.toContain('mcp__')
  })

  it('still respects allowedBuiltinTools alongside allowedMcpServers', () => {
    const { args } = buildSubagentArgs({
      ...baseOpts,
      mcpConfigPath: '/tmp/mcp.json',
      allowedBuiltinTools: ['Bash', 'Read'],
      allowedMcpServers: ['dc'],
    })
    const idx = args.indexOf('--allowedTools')
    const val = args[idx + 1]
    expect(val).toBe('mcp__dc Bash Read')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugin && bun test test/subagent-process.test.ts`
Expected: FAIL — `allowedMcpServers` doesn't exist on `SubagentSpawnOptions` yet.

- [ ] **Step 3: Add KNOWN_MCP_SERVERS and update SubagentSpawnOptions**

In `plugin/dispatcher/subagent-process.ts`:

```typescript
/** Known MCP server prefixes and their display names. */
export const KNOWN_MCP_SERVERS: Record<string, string> = {
  dc: 'DC Tools',
  claude_ai_Gmail: 'Gmail',
  claude_ai_Google_Calendar: 'Google Calendar',
  claude_ai_Slack: 'Slack',
  claude_ai_Notion: 'Notion',
  claude_ai_Asana: 'Asana',
  plugin_telegram_telegram: 'Telegram',
}

/** All known MCP server prefixes. */
export const ALL_MCP_SERVER_PREFIXES = Object.keys(KNOWN_MCP_SERVERS)
```

Add `allowedMcpServers?: string[] | null` to `SubagentSpawnOptions` (alongside existing `allowedBuiltinTools`).

Update `buildSubagentArgs` lines 155-165:

```typescript
if (opts.mcpConfigPath) {
  args.push('--mcp-config', opts.mcpConfigPath)
  const builtinTools = opts.allowedBuiltinTools ?? ALL_BUILTIN_TOOLS
  const serverPrefixes = opts.allowedMcpServers ?? ALL_MCP_SERVER_PREFIXES
  const mcpPrefixes = serverPrefixes.map(s => `mcp__${s}`)
  args.push(
    '--allowedTools',
    [...mcpPrefixes, ...builtinTools].join(' '),
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugin && bun test test/subagent-process.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add plugin/dispatcher/subagent-process.ts plugin/test/subagent-process.test.ts
git commit -m "feat(tool-access): add KNOWN_MCP_SERVERS registry and allowedMcpServers support"
```

---

### Task 2: Update agent schema (allowedMcpTools → allowedMcpServers)

**Files:**
- Modify: `plugin/agents.ts:103-123`
- Test: `plugin/test/agents.test.ts`

- [ ] **Step 1: Write the failing test**

In `plugin/test/agents.test.ts`, add:

```typescript
describe('allowedMcpServers schema', () => {
  it('accepts null allowedMcpServers (all servers)', () => {
    const agent = { ...validAgent, allowedMcpServers: null }
    const result = AgentDefSchema.safeParse(agent)
    expect(result.success).toBe(true)
  })

  it('accepts explicit server list', () => {
    const agent = { ...validAgent, allowedMcpServers: ['dc', 'claude_ai_Gmail'] }
    const result = AgentDefSchema.safeParse(agent)
    expect(result.success).toBe(true)
  })

  it('accepts empty array (no servers)', () => {
    const agent = { ...validAgent, allowedMcpServers: [] }
    const result = AgentDefSchema.safeParse(agent)
    expect(result.success).toBe(true)
  })

  it('migrates allowedMcpTools to allowedMcpServers on load', () => {
    // Simulate an old-format agent with allowedMcpTools
    const oldAgent = { ...validAgent, allowedMcpTools: ['dc_send_file', 'dc_chat_history'] }
    const result = AgentDefSchema.safeParse(oldAgent)
    expect(result.success).toBe(true)
    // allowedMcpTools should still parse (passthrough) but not break
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugin && bun test test/agents.test.ts`
Expected: FAIL — `allowedMcpServers` not in schema yet.

- [ ] **Step 3: Update AgentDefSchema**

In `plugin/agents.ts`, replace the `allowedMcpTools` field:

```typescript
/**
 * Allowlist of MCP server prefixes (dc, claude_ai_Gmail, etc.) this agent
 * may use. null or absent = all servers allowed. [] = no MCP servers.
 * Replaces the previous per-tool allowedMcpTools field.
 */
allowedMcpServers: z.array(z.string()).nullable().optional(),
```

Keep `allowedMcpTools` as a deprecated passthrough field so old YAML files don't fail validation:

```typescript
/** @deprecated Use allowedMcpServers. Kept for migration compat. */
allowedMcpTools: z.array(z.string()).nullable().optional(),
```

Add a migration helper in `agents.ts`:

```typescript
/**
 * Migrate legacy allowedMcpTools (per-tool names) to allowedMcpServers
 * (per-server prefixes). Called on agent load.
 */
export function migrateToolsToServers(agent: AgentDef): AgentDef {
  if (agent.allowedMcpTools != null && agent.allowedMcpServers === undefined) {
    // All DC tools start with dc_ prefix → server is 'dc'
    // This is the only MCP server that had per-tool selection.
    const hasAnyDcTool = agent.allowedMcpTools.length > 0
    agent.allowedMcpServers = hasAnyDcTool ? ['dc'] : []
    delete (agent as any).allowedMcpTools
  }
  return agent
}
```

Call `migrateToolsToServers` in `getAgent()` and `listAgents()`.

Also update `DraftAgentSchema` similarly — replace `allowedMcpTools` with `allowedMcpServers`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugin && bun test test/agents.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add plugin/agents.ts plugin/test/agents.test.ts
git commit -m "feat(tool-access): replace allowedMcpTools with allowedMcpServers in agent schema"
```

---

### Task 3: Update server.ts — filtering and payload

**Files:**
- Modify: `plugin/server.ts:148-153,202-216`
- Modify: `plugin/apps/agent-setup-app.ts:16-24,354-356,517-518,531-537,560-564`

- [ ] **Step 1: Update getAvailableMcpTools → getAvailableMcpServers**

In `plugin/server.ts`, replace `getAvailableMcpTools()` with:

```typescript
import { KNOWN_MCP_SERVERS } from './dispatcher/subagent-process.js'

/** Available MCP servers for the agent-setup card. */
export function getAvailableMcpServers(): Array<{ prefix: string; label: string; toolCount: number }> {
  const dcTools = [
    ...coreTools.map(t => t.name),
    ...apps.flatMap(a => a.tools()).map(t => t.name),
  ].filter(n => !SUBAGENT_TOOL_BLOCKLIST.has(n))

  const servers: Array<{ prefix: string; label: string; toolCount: number }> = []

  // DC tools are always available
  servers.push({ prefix: 'dc', label: KNOWN_MCP_SERVERS.dc, toolCount: dcTools.length })

  // Other known servers — we can't enumerate their tools, but we know
  // they exist if the user has them configured. Include them all; Claude
  // Code silently ignores --allowedTools prefixes for absent servers.
  for (const [prefix, label] of Object.entries(KNOWN_MCP_SERVERS)) {
    if (prefix === 'dc') continue
    servers.push({ prefix, label, toolCount: 0 })
  }

  return servers
}
```

- [ ] **Step 2: Update AppContext interface**

In `plugin/webxdc-app.ts`, replace `getAvailableMcpTools` with:

```typescript
getAvailableMcpServers: () => Array<{ prefix: string; label: string; toolCount: number }>
```

- [ ] **Step 3: Update agent-setup-app.ts payload and handlers**

In `plugin/apps/agent-setup-app.ts`:

Replace `availableToolsPayload`:

```typescript
function availableToolsPayload(ctx: AppContext) {
  return {
    availableBuiltinTools: ALL_BUILTIN_TOOLS.map(name => ({
      name,
      description: BUILTIN_TOOL_DESCRIPTIONS[name] ?? '',
    })),
    availableMcpServers: ctx.getAvailableMcpServers(),
  }
}
```

In the `editRequest` handler (line 354-355), change:
- `allowedMcpTools: agent.allowedMcpTools ?? null` → `allowedMcpServers: agent.allowedMcpServers ?? null`

In the `saveEdit` handler (lines 517-518, 531-537, 560-564), change:
- `allowedMcpTools` → `allowedMcpServers` everywhere
- The tool change detection comparison stays structurally the same, just the field name changes

In the `create` handler, same field name change.

- [ ] **Step 4: Update DC tool manifest filtering in server.ts**

In `server.ts` lines 208-211, change from per-tool filtering to per-server check:

```typescript
const agent = resolved?.agent
const dcServerAllowed = agent?.allowedMcpServers == null || agent.allowedMcpServers.includes('dc')
const filteredToolDefs = dcServerAllowed ? toolDefs : []
```

- [ ] **Step 5: Wire getAvailableMcpServers into AppContext**

In `server.ts` where AppContext is constructed (~line 408), replace:
```typescript
getAvailableMcpTools: () => getAvailableMcpTools(),
// →
getAvailableMcpServers: () => getAvailableMcpServers(),
```

- [ ] **Step 6: Pass allowedMcpServers to SubagentProcess**

In `server.ts` where SubagentProcess is constructed, change:
```typescript
allowedBuiltinTools: agent?.allowedBuiltinTools,
// Add:
allowedMcpServers: agent?.allowedMcpServers,
```

- [ ] **Step 7: Run all tests**

Run: `cd plugin && bun test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add plugin/server.ts plugin/apps/agent-setup-app.ts plugin/webxdc-app.ts
git commit -m "feat(tool-access): wire allowedMcpServers through server and agent-setup"
```

---

### Task 4: Update WebXDC tool picker UI

**Files:**
- Modify: `plugin/webxdc/agent-setup.html`

- [ ] **Step 1: Update the renderToolPicker function**

Replace the MCP tools group rendering. Instead of per-tool checkboxes, MCP servers get single toggles:

```javascript
var availableMcpServers = [];

function renderToolPicker(containerId, allowedBuiltinTools, allowedMcpServers) {
  var container = document.getElementById(containerId);
  if (!container) return;
  container.textContent = '';

  // Built-in tools: per-tool checkboxes (unchanged)
  if (availableBuiltinTools.length > 0) {
    renderBuiltinToolsSection(container, allowedBuiltinTools);
  }

  // MCP servers: one toggle per server
  if (availableMcpServers.length > 0) {
    renderMcpServersSection(container, allowedMcpServers);
  }
}
```

Add `renderMcpServersSection`:

```javascript
function renderMcpServersSection(container, allowedMcpServers) {
  var allOn = allowedMcpServers === null;

  var section = document.createElement('div');
  section.className = 'tool-section';

  var header = document.createElement('div');
  header.className = 'tool-header';
  var enabledCount = allOn ? availableMcpServers.length : allowedMcpServers.length;

  var headerLeft = document.createElement('div');
  headerLeft.className = 'tool-header-left';
  headerLeft.textContent = 'MCP Servers';
  var countSpan = document.createElement('span');
  countSpan.className = 'tool-count' + (enabledCount === availableMcpServers.length ? ' all-on' : '');
  countSpan.textContent = enabledCount + ' / ' + availableMcpServers.length + (enabledCount === availableMcpServers.length ? ' \u2713' : '');
  headerLeft.appendChild(countSpan);
  var arrow = document.createElement('span');
  arrow.className = 'tool-arrow';
  arrow.textContent = '\u25B6';
  header.appendChild(headerLeft);
  header.appendChild(arrow);

  var body = document.createElement('div');
  body.className = 'tool-body';
  var selectAllDiv = document.createElement('div');
  selectAllDiv.className = 'tool-select-all';
  var selectAllSpan = document.createElement('span');
  selectAllSpan.textContent = enabledCount === availableMcpServers.length ? 'Deselect all' : 'Select all';
  selectAllDiv.appendChild(selectAllSpan);
  body.appendChild(selectAllDiv);

  var checkboxes = [];
  availableMcpServers.forEach(function(srv) {
    var row = document.createElement('div');
    row.className = 'tool-row';
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = allOn || allowedMcpServers.indexOf(srv.prefix) >= 0;
    cb.dataset.toolName = srv.prefix;
    cb.dataset.toolField = 'mcp';
    checkboxes.push(cb);
    var nameSpan = document.createElement('span');
    nameSpan.className = 'tool-name' + (cb.checked ? '' : ' disabled');
    nameSpan.textContent = srv.label;
    var descSpan = document.createElement('span');
    descSpan.className = 'tool-desc';
    descSpan.textContent = srv.toolCount > 0 ? srv.toolCount + ' tools' : '';
    row.appendChild(cb);
    row.appendChild(nameSpan);
    row.appendChild(descSpan);
    cb.addEventListener('change', function() {
      nameSpan.className = 'tool-name' + (cb.checked ? '' : ' disabled');
      updateToolCount(countSpan, checkboxes, availableMcpServers.length);
      updateSelectAllText(selectAllSpan, checkboxes);
    });
    body.appendChild(row);
  });

  selectAllSpan.addEventListener('click', function() {
    var allChecked = checkboxes.every(function(c) { return c.checked; });
    checkboxes.forEach(function(c) {
      c.checked = !allChecked;
      var nameEl = c.parentElement.querySelector('.tool-name');
      if (nameEl) nameEl.className = 'tool-name' + (c.checked ? '' : ' disabled');
    });
    updateToolCount(countSpan, checkboxes, availableMcpServers.length);
    updateSelectAllText(selectAllSpan, checkboxes);
  });

  header.addEventListener('click', function() {
    var expanded = body.classList.toggle('expanded');
    arrow.textContent = expanded ? '\u25BC' : '\u25B6';
  });

  section.appendChild(header);
  section.appendChild(body);
  container.appendChild(section);
}
```

- [ ] **Step 2: Update collectToolPickerState**

```javascript
function collectToolPickerState(containerId) {
  var container = document.getElementById(containerId);
  if (!container) return { allowedBuiltinTools: null, allowedMcpServers: null };
  var checkboxes = container.querySelectorAll('input[type="checkbox"]');
  var builtinAll = true, mcpAll = true;
  var builtinList = [], mcpList = [];
  checkboxes.forEach(function(cb) {
    if (cb.dataset.toolField === 'builtin') {
      if (cb.checked) builtinList.push(cb.dataset.toolName);
      else builtinAll = false;
    } else if (cb.dataset.toolField === 'mcp') {
      if (cb.checked) mcpList.push(cb.dataset.toolName);
      else mcpAll = false;
    }
  });
  return {
    allowedBuiltinTools: builtinAll ? null : builtinList,
    allowedMcpServers: mcpAll ? null : mcpList,
  };
}
```

- [ ] **Step 3: Update init/edit handlers to use new field names**

Replace all references to `availableMcpTools` with `availableMcpServers` in the payload handlers. Update the `create()` and `saveEdit()` functions to send `allowedMcpServers` instead of `allowedMcpTools`.

- [ ] **Step 4: Bump APP_VERSION**

Change `var APP_VERSION = 1.33` to `var APP_VERSION = 1.34`.

- [ ] **Step 5: Commit**

```bash
git add plugin/webxdc/agent-setup.html
git commit -m "feat(tool-access): MCP server toggles in agent-setup UI"
```

---

### Task 5: Update CLAUDE.md and tests

**Files:**
- Modify: `CLAUDE.md`
- Modify: `plugin/test/agents.test.ts` (update any existing allowedMcpTools tests)

- [ ] **Step 1: Update CLAUDE.md**

In the "Per-agent tool access" paragraph, change the description of `allowedMcpTools` to `allowedMcpServers`:

> `allowedMcpServers` (string array or null). `null` or absent means "all
> servers allowed"; `[]` means "no MCP servers." Each entry is a server
> prefix (e.g., `dc`, `claude_ai_Gmail`). Restrictions are enforced at
> spawn time via `--allowedTools` with `mcp__<prefix>` entries.

- [ ] **Step 2: Update existing tests that reference allowedMcpTools**

Search for `allowedMcpTools` in test files and update to `allowedMcpServers`.

- [ ] **Step 3: Run full test suite**

Run: `cd plugin && bun test`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add -f CLAUDE.md plugin/test/agents.test.ts
git commit -m "docs: update CLAUDE.md and tests for allowedMcpServers"
```

---

### Task 6: Manual smoke test

- [ ] **Step 1: Restart the dispatcher** (`bun server.ts`)
- [ ] **Step 2: Open agent-setup card** — send "manage agents" in a paired chat
- [ ] **Step 3: Verify MCP Servers section** — should show DC Tools, Gmail, Google Calendar, Slack, Notion, Asana, Telegram as toggles
- [ ] **Step 4: Create agent with Gmail disabled** — uncheck Gmail, create agent, verify the YAML has `allowedMcpServers: [dc, claude_ai_Google_Calendar, ...]`
- [ ] **Step 5: Edit agent** — verify toggles reflect saved state
- [ ] **Step 6: Test enforcement** — bind to the restricted agent, send a message, verify Gmail tools are not available to the subagent
