# Per-Agent Tool Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow each agent to restrict which built-in and MCP tools its subagent can use, configured via a collapsible tool picker in the agent-setup WebXDC card.

**Architecture:** Two new optional fields on AgentDef (`allowedBuiltinTools`, `allowedMcpTools`) control spawn-time filtering. Built-in tools are filtered via `--allowedTools` CLI flag; MCP tools are filtered by pruning the manifest before writing it to disk. The agent-setup card gets a collapsible tool picker UI below the existing settings.

**Tech Stack:** TypeScript/Bun, Zod schemas, WebXDC HTML/JS, YAML persistence

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `plugin/agents.ts` | Modify | Add `allowedBuiltinTools`/`allowedMcpTools` to schema |
| `plugin/dispatcher/subagent-process.ts` | Modify | Export `ALL_BUILTIN_TOOLS` constant; filter `--allowedTools` by agent config |
| `plugin/server.ts` | Modify | Filter MCP `toolDefs` by agent config; pass available tools in agent-setup init |
| `plugin/apps/agent-setup-app.ts` | Modify | Include available tools in init/edit payloads; handle new fields on create/save |
| `plugin/webxdc/agent-setup.html` | Modify | Add collapsible tool picker UI to create and edit forms |
| `plugin/test/agents.test.ts` | Modify | Test schema accepts/omits new fields |
| `plugin/test/subagent-process.test.ts` | Modify | Test `--allowedTools` filtering with `allowedBuiltinTools` |

---

### Task 1: Schema — Add allowedBuiltinTools and allowedMcpTools to AgentDef

**Files:**
- Modify: `plugin/agents.ts:98-108`
- Test: `plugin/test/agents.test.ts`

- [ ] **Step 1: Write the failing tests**

Add these tests to the existing `describe('agents')` block in `plugin/test/agents.test.ts`:

```typescript
describe('allowedBuiltinTools and allowedMcpTools', () => {
  test('schema accepts agent with allowedBuiltinTools', () => {
    const agent: AgentDef = {
      id: 'tool-test',
      name: 'Tool Test',
      model: 'claude-sonnet-4-6',
      description: '',
      system: '',
      tools: [],
      allowedBuiltinTools: ['Read', 'Glob', 'Grep'],
    }
    agents.saveAgent(agent)
    const loaded = agents.getAgent('tool-test')
    expect(loaded).not.toBeNull()
    expect(loaded!.allowedBuiltinTools).toEqual(['Read', 'Glob', 'Grep'])
  })

  test('schema accepts agent with allowedMcpTools', () => {
    const agent: AgentDef = {
      id: 'mcp-test',
      name: 'MCP Test',
      model: 'claude-sonnet-4-6',
      description: '',
      system: '',
      tools: [],
      allowedMcpTools: ['reply', 'dc_react'],
    }
    agents.saveAgent(agent)
    const loaded = agents.getAgent('mcp-test')
    expect(loaded).not.toBeNull()
    expect(loaded!.allowedMcpTools).toEqual(['reply', 'dc_react'])
  })

  test('schema accepts null for both fields (all tools allowed)', () => {
    const agent: AgentDef = {
      id: 'null-test',
      name: 'Null Test',
      model: 'claude-sonnet-4-6',
      description: '',
      system: '',
      tools: [],
      allowedBuiltinTools: null,
      allowedMcpTools: null,
    }
    agents.saveAgent(agent)
    const loaded = agents.getAgent('null-test')
    expect(loaded).not.toBeNull()
    expect(loaded!.allowedBuiltinTools).toBeNull()
    expect(loaded!.allowedMcpTools).toBeNull()
  })

  test('fields are optional — existing agents without them still load', () => {
    // Write a YAML file without the new fields (simulating a pre-existing agent).
    const { writeFileSync } = require('node:fs')
    const { join } = require('node:path')
    const YAML = require('yaml')
    const dir = agents.getAgentsDir()
    writeFileSync(
      join(dir, 'legacy-test.yaml'),
      YAML.stringify({
        id: 'legacy-test',
        name: 'Legacy',
        model: 'claude-sonnet-4-6',
        description: '',
        system: '',
        tools: [],
      }),
    )
    const loaded = agents.getAgent('legacy-test')
    expect(loaded).not.toBeNull()
    expect(loaded!.allowedBuiltinTools).toBeUndefined()
    expect(loaded!.allowedMcpTools).toBeUndefined()
  })

  test('empty arrays mean no tools allowed', () => {
    const agent: AgentDef = {
      id: 'empty-test',
      name: 'Empty Test',
      model: 'claude-sonnet-4-6',
      description: '',
      system: '',
      tools: [],
      allowedBuiltinTools: [],
      allowedMcpTools: [],
    }
    agents.saveAgent(agent)
    const loaded = agents.getAgent('empty-test')
    expect(loaded).not.toBeNull()
    expect(loaded!.allowedBuiltinTools).toEqual([])
    expect(loaded!.allowedMcpTools).toEqual([])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugin && bun test test/agents.test.ts`
Expected: FAIL — `allowedBuiltinTools` and `allowedMcpTools` are not recognized by the schema, and `getAgentsDir` is not exported.

- [ ] **Step 3: Implement the schema changes**

In `plugin/agents.ts`, add two fields to `AgentDefSchema` (after the `metadata` field at line 107):

```typescript
export const AgentDefSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'id must be a lowercase slug'),
  name: z.string().min(1).max(256),
  model: z.enum(ALLOWED_MODELS),
  description: z.string().max(2048).default(''),
  system: z.string().max(100_000).default(''),
  tools: z.array(z.object({ type: z.string() })).default([]),
  skills: z.array(z.unknown()).optional(),
  mcp_servers: z.array(z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  allowedBuiltinTools: z.array(z.string()).nullable().optional(),
  allowedMcpTools: z.array(z.string()).nullable().optional(),
})
```

Also export a getter for AGENTS_DIR so tests can write raw YAML:

```typescript
/** Get the current agents directory path (for tests). */
export function getAgentsDir(): string {
  return AGENTS_DIR
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugin && bun test test/agents.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add plugin/agents.ts plugin/test/agents.test.ts
git commit -m "feat(agents): add allowedBuiltinTools and allowedMcpTools schema fields (#16)"
```

---

### Task 2: Enforcement — Filter --allowedTools by agent config

**Files:**
- Modify: `plugin/dispatcher/subagent-process.ts:118-143`
- Test: `plugin/test/subagent-process.test.ts`

- [ ] **Step 1: Write the failing tests**

Add these tests to the existing `describe('buildSubagentArgs')` block in `plugin/test/subagent-process.test.ts`:

```typescript
test('allowedBuiltinTools filters the --allowedTools list', () => {
  const { args } = buildSubagentArgs(baseOpts({
    mcpConfigPath: '/tmp/mcp.json',
    allowedBuiltinTools: ['Read', 'Glob', 'Grep'],
  }))
  const i = args.indexOf('--allowedTools')
  const list = args[i + 1]
  expect(list).toContain('mcp__dc')  // always present
  expect(list).toContain('Read')
  expect(list).toContain('Glob')
  expect(list).toContain('Grep')
  expect(list).not.toContain('Bash')
  expect(list).not.toContain('Edit')
  expect(list).not.toContain('Write')
})

test('allowedBuiltinTools null means all built-in tools', () => {
  const { args } = buildSubagentArgs(baseOpts({
    mcpConfigPath: '/tmp/mcp.json',
    allowedBuiltinTools: null,
  }))
  const i = args.indexOf('--allowedTools')
  const list = args[i + 1]
  expect(list).toContain('Bash')
  expect(list).toContain('Read')
  expect(list).toContain('Edit')
  expect(list).toContain('Write')
})

test('allowedBuiltinTools undefined means all built-in tools', () => {
  const { args } = buildSubagentArgs(baseOpts({
    mcpConfigPath: '/tmp/mcp.json',
    // allowedBuiltinTools not set
  }))
  const i = args.indexOf('--allowedTools')
  const list = args[i + 1]
  expect(list).toContain('Bash')
  expect(list).toContain('Read')
})

test('allowedBuiltinTools empty array means only mcp__dc', () => {
  const { args } = buildSubagentArgs(baseOpts({
    mcpConfigPath: '/tmp/mcp.json',
    allowedBuiltinTools: [],
  }))
  const i = args.indexOf('--allowedTools')
  const list = args[i + 1]
  expect(list).toBe('mcp__dc')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugin && bun test test/subagent-process.test.ts`
Expected: FAIL — `allowedBuiltinTools` is not a property of `SubagentSpawnOptions`.

- [ ] **Step 3: Implement the filtering**

In `plugin/dispatcher/subagent-process.ts`:

First, add a new optional field to `SubagentSpawnOptions` (after `logf` on line 67):

```typescript
  /** Per-agent built-in tool allowlist. null/undefined = all tools. */
  allowedBuiltinTools?: string[] | null
```

Then, add the `ALL_BUILTIN_TOOLS` constant and `BUILTIN_TOOL_DESCRIPTIONS` map above `buildSubagentArgs` (before line 74):

```typescript
/**
 * Full set of built-in tools a subagent can use. Used as the default
 * when an agent has no allowedBuiltinTools restriction. Also sent to
 * the agent-setup card so it knows which tools to render.
 */
export const ALL_BUILTIN_TOOLS = [
  // Core built-ins. Gated ones (Bash/Edit/Write/NotebookEdit/
  // WebFetch/WebSearch) still fire the PreToolUse hook.
  'Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob',
  'WebFetch', 'WebSearch', 'NotebookEdit',
  // Task tooling (spawn/monitor/stop sub-subagents).
  'Task', 'TaskOutput', 'TaskStop', 'TodoWrite',
  // User skills and deferred-tool loading — required now that
  // user-level settings are inherited.
  'Skill', 'ToolSearch',
  // Structured prompting + language-server queries.
  'AskUserQuestion', 'LSP',
  // Plan mode + worktree management — useful for coding agents.
  'EnterPlanMode', 'ExitPlanMode', 'EnterWorktree', 'ExitWorktree',
  // Intentionally excluded: CronCreate/Delete/List and
  // RemoteTrigger. These have persistence side effects (jobs
  // that outlive the turn / out-of-band invocation) that
  // shouldn't be triggered from a DC chat without further
  // thought.
]

/** Short descriptions for each built-in tool (shown in the setup card). */
export const BUILTIN_TOOL_DESCRIPTIONS: Record<string, string> = {
  Bash: 'Run shell commands',
  Read: 'Read file contents',
  Edit: 'Modify existing files',
  Write: 'Create new files',
  Grep: 'Search file contents',
  Glob: 'Find files by pattern',
  WebFetch: 'Fetch web pages',
  WebSearch: 'Search the web',
  NotebookEdit: 'Edit Jupyter notebooks',
  Task: 'Spawn sub-tasks',
  TaskOutput: 'Read sub-task output',
  TaskStop: 'Stop sub-tasks',
  TodoWrite: 'Track progress with todos',
  Skill: 'Use installed skills',
  ToolSearch: 'Load deferred tools',
  AskUserQuestion: 'Ask clarifying questions',
  LSP: 'Language server queries',
  EnterPlanMode: 'Enter plan mode',
  ExitPlanMode: 'Exit plan mode',
  EnterWorktree: 'Work in isolated branch',
  ExitWorktree: 'Leave isolated branch',
}
```

Then refactor the `--allowedTools` block inside `buildSubagentArgs`. Replace lines 118–143 (the `if (opts.mcpConfigPath)` block) with:

```typescript
  if (opts.mcpConfigPath) {
    // No --strict-mcp-config: our dc server is merged with the user's
    // global MCP config (Gmail, Calendar, Telegram, etc.) so subagents
    // inherit the same MCP tools the terminal session has.
    args.push('--mcp-config', opts.mcpConfigPath)
    const builtinTools = opts.allowedBuiltinTools ?? ALL_BUILTIN_TOOLS
    args.push(
      '--allowedTools',
      [
        // Our DC MCP server — whole server allowed, dispatcher-side
        // authorization gates chat_id.
        'mcp__dc',
        ...builtinTools,
      ].join(' '),
    )
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugin && bun test test/subagent-process.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `cd plugin && bun test`
Expected: PASS (existing tests should still work since null/undefined defaults to the same list)

- [ ] **Step 6: Commit**

```bash
git add plugin/dispatcher/subagent-process.ts plugin/test/subagent-process.test.ts
git commit -m "feat(subagent): filter --allowedTools by agent config (#16)"
```

---

### Task 3: Enforcement — Filter MCP tool manifest by agent config

**Files:**
- Modify: `plugin/server.ts:189-197`

- [ ] **Step 1: Add MCP tool filtering in spawnSubagentForChat**

In `plugin/server.ts`, after the `toolDefs` array is built (line 192) and before `generateHookConfig` is called (line 193), add the MCP filtering:

```typescript
  const toolDefs = [
    ...coreTools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    ...apps.flatMap((a) => a.tools()).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  ].filter((t) => !SUBAGENT_TOOL_BLOCKLIST.has(t.name))

  // Per-agent MCP tool filtering: if the agent has an explicit allowlist,
  // only include tools whose name is in it. null/undefined = all tools.
  const agent = resolved?.agent
  const filteredToolDefs = agent?.allowedMcpTools != null
    ? toolDefs.filter(t => agent.allowedMcpTools!.includes(t.name))
    : toolDefs

  const { settingsPath, mcpConfigPath, tempDir } = generateHookConfig({
    hookScriptPath: HOOK_SCRIPT,
    toolsProxyPath: TOOLS_PROXY,
    toolDefs: filteredToolDefs,
  })
```

- [ ] **Step 2: Pass allowedBuiltinTools to SubagentProcess constructor**

In the same function, find the first `new SubagentProcess({...})` call (around line 222). Add `allowedBuiltinTools` to the options:

```typescript
    allowedBuiltinTools: agent?.allowedBuiltinTools,
```

There is a second `new SubagentProcess(...)` in the resume-fallback path (around line 254). Add the same field there too:

```typescript
    allowedBuiltinTools: agent?.allowedBuiltinTools,
```

- [ ] **Step 3: Export getAvailableMcpTools for the agent-setup app**

After the `SUBAGENT_TOOL_BLOCKLIST` definition (around line 145), add:

```typescript
/** Available MCP tool names + descriptions for the agent-setup card. */
export function getAvailableMcpTools(): Array<{ name: string; description: string }> {
  return [
    ...coreTools.map((t) => ({ name: t.name, description: t.description })),
    ...apps.flatMap((a) => a.tools()).map((t) => ({ name: t.name, description: t.description })),
  ].filter((t) => !SUBAGENT_TOOL_BLOCKLIST.has(t.name))
}
```

- [ ] **Step 4: Run full test suite**

Run: `cd plugin && bun test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add plugin/server.ts
git commit -m "feat(dispatcher): filter MCP manifest and pass allowedBuiltinTools (#16)"
```

---

### Task 4: Agent-setup app — Pass available tools in init/edit payloads

**Files:**
- Modify: `plugin/apps/agent-setup-app.ts`

- [ ] **Step 1: Add imports**

At the top of `plugin/apps/agent-setup-app.ts`, add:

```typescript
import { ALL_BUILTIN_TOOLS, BUILTIN_TOOL_DESCRIPTIONS } from '../dispatcher/subagent-process.js'
import { getAvailableMcpTools } from '../server.js'
```

- [ ] **Step 2: Create a helper for the available tools payload**

Below the imports, add a helper function:

```typescript
/** Build the available-tools payload fields for init/edit. */
function availableToolsPayload() {
  return {
    availableBuiltinTools: ALL_BUILTIN_TOOLS.map(name => ({
      name,
      description: BUILTIN_TOOL_DESCRIPTIONS[name] ?? '',
    })),
    availableMcpTools: getAvailableMcpTools(),
  }
}
```

- [ ] **Step 3: Add available tools to the init payload**

In the `sendInit` function (around line 61), spread the helper into the payload object. Add after the `senderAddr` field:

```typescript
    const payload = {
      type: 'init' as const,
      version: agentSetup.getAgentSetupVersion(),
      draft: {
        ...draft,
        skipPermissions: agents.getSkipPermissions(draft as agents.AgentDef),
        iconMirror: agents.getIconMirror(draft as agents.AgentDef),
      },
      existingAgents: listExistingForPicker(sourceChatId),
      startScreen,
      senderAddr: 'server',
      ...availableToolsPayload(),
    }
```

- [ ] **Step 4: Add available tools and current config to the edit payload**

In the `editRequest` handler (around line 330), add `allowedBuiltinTools` and `allowedMcpTools` to `editDraft`:

```typescript
        const editDraft = {
          id: agent.id,
          name: agent.name,
          model: agent.model,
          system: agent.system,
          tools: agent.tools ?? [],
          skipPermissions: agents.getSkipPermissions(agent),
          iconMirror: agents.getIconMirror(agent),
          allowedBuiltinTools: agent.allowedBuiltinTools ?? null,
          allowedMcpTools: agent.allowedMcpTools ?? null,
        }
```

And spread `availableToolsPayload()` into the edit update payload:

```typescript
          const update = JSON.stringify({
            payload: {
              type: 'edit',
              draft: editDraft,
              version: agentSetup.getAgentSetupVersion(),
              senderAddr: 'server',
              ...availableToolsPayload(),
            },
            summary: 'Editing agent',
          })
```

- [ ] **Step 5: Handle tool fields on create**

In the `create` handler (around line 644), after parsing the draft and before building `newAgent`, read the tool fields:

```typescript
        const allowedBuiltinTools = (payload as { allowedBuiltinTools?: string[] | null }).allowedBuiltinTools ?? undefined
        const allowedMcpTools = (payload as { allowedMcpTools?: string[] | null }).allowedMcpTools ?? undefined
```

Include them in the `newAgent` object:

```typescript
          const newAgent: agents.AgentDef = {
            ...draft,
            id: agentId,
            allowedBuiltinTools,
            allowedMcpTools,
          }
```

- [ ] **Step 6: Handle tool fields on saveEdit**

In the `saveEdit` handler (around line 483), after reading `iconMirror`, read the tool fields:

```typescript
        const allowedBuiltinTools = (payload as { allowedBuiltinTools?: string[] | null }).allowedBuiltinTools ?? undefined
        const allowedMcpTools = (payload as { allowedMcpTools?: string[] | null }).allowedMcpTools ?? undefined
```

Include them in the `updated` object:

```typescript
          const updated: agents.AgentDef = {
            ...draft,
            id: agentId,
            metadata: agent.metadata ? { ...agent.metadata } : undefined,
            allowedBuiltinTools,
            allowedMcpTools,
          }
```

Add tool-change detection to the `needsRestart` logic. After the existing `mirrorChanged` line:

```typescript
          const prevBuiltinTools = JSON.stringify(agent.allowedBuiltinTools ?? null)
          const newBuiltinTools = JSON.stringify(allowedBuiltinTools ?? null)
          const prevMcpToolsList = JSON.stringify(agent.allowedMcpTools ?? null)
          const newMcpToolsList = JSON.stringify(allowedMcpTools ?? null)
          const toolsChanged = prevBuiltinTools !== newBuiltinTools || prevMcpToolsList !== newMcpToolsList
```

Update the `needsRestart` line:

```typescript
          const needsRestart = modelChanged || systemChanged || toolsChanged
```

Update the restart notification message:

```typescript
            const restartMsg = modelChanged
              ? `Agent updated. Restarting with new model (${draft.model.replace('claude-', '')})...`
              : toolsChanged
                ? 'Agent updated. Restarting with new tool configuration...'
                : 'Agent updated. Restarting...'
```

- [ ] **Step 7: Run full test suite**

Run: `cd plugin && bun test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add plugin/apps/agent-setup-app.ts
git commit -m "feat(agent-setup): pass available tools in init/edit payloads, save on create/edit (#16)"
```

---

### Task 5: WebXDC UI — Collapsible tool picker in agent-setup card

**Files:**
- Modify: `plugin/webxdc/agent-setup.html`

- [ ] **Step 1: Add CSS for the tool picker**

In `plugin/webxdc/agent-setup.html`, add these styles inside the `<style>` block (before `</style>`):

```css
.tool-section {
  border: 1px solid #30363d;
  border-radius: 10px;
  margin-bottom: 8px;
  overflow: hidden;
}
.tool-header {
  background: #161b22;
  padding: 10px 14px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  cursor: pointer;
  user-select: none;
}
.tool-header-left {
  font-size: 13px;
  font-weight: 600;
}
.tool-count {
  font-size: 11px;
  color: #8b949e;
  margin-left: 8px;
}
.tool-count.all-on { color: #3fb950; }
.tool-arrow { color: #8b949e; font-size: 12px; }
.tool-body {
  padding: 8px 14px;
  background: #0d1117;
  display: none;
}
.tool-body.expanded { display: block; }
.tool-select-all {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 6px;
}
.tool-select-all span {
  font-size: 11px;
  color: #58a6ff;
  cursor: pointer;
}
.tool-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 0;
  font-size: 13px;
  border-bottom: 1px solid #21262d;
}
.tool-row:last-child { border-bottom: none; }
.tool-row input[type="checkbox"] { flex-shrink: 0; }
.tool-name { white-space: nowrap; }
.tool-desc {
  color: #6e7681;
  font-size: 11px;
  margin-left: auto;
  text-align: right;
}
.tool-name.disabled { color: #6e7681; }
```

- [ ] **Step 2: Add tool picker HTML to the Create form (step2)**

In `plugin/webxdc/agent-setup.html`, inside the `<div id="step2">` block, after the "Skip permissions" label (after line 209), add:

```html
      <div style="margin-top:16px;">
        <div class="section-label">Allowed Tools</div>
        <div id="create-tool-picker"></div>
      </div>
```

- [ ] **Step 3: Add tool picker HTML to the Edit form (step3)**

In the `<div id="step3">` block, after the "Icon orientation" radio buttons (after line 241), add:

```html
      <div style="margin-top:16px;">
        <div class="section-label">Allowed Tools</div>
        <div id="edit-tool-picker"></div>
      </div>
```

- [ ] **Step 4: Add JavaScript for the tool picker**

In the `<script>` section of `agent-setup.html`, add these functions. Place them before the existing `gotoCreate()` function. All DOM construction uses `createElement`/`textContent` — no `innerHTML`:

```javascript
// ─── Tool picker ────────────────────────────────────────
var availableBuiltinTools = [];
var availableMcpTools = [];

function renderToolPicker(containerId, allowedBuiltinTools, allowedMcpTools) {
  var container = document.getElementById(containerId);
  if (!container) return;
  container.textContent = '';

  var groups = [];
  if (availableBuiltinTools.length > 0) {
    groups.push({
      label: 'Built-in Tools',
      tools: availableBuiltinTools,
      allowed: allowedBuiltinTools,
      field: 'builtin',
    });
  }
  if (availableMcpTools.length > 0) {
    groups.push({
      label: 'DC Tools',
      tools: availableMcpTools,
      allowed: allowedMcpTools,
      field: 'mcp',
    });
  }

  groups.forEach(function(group) {
    var section = document.createElement('div');
    section.className = 'tool-section';

    // Header
    var header = document.createElement('div');
    header.className = 'tool-header';
    var allOn = group.allowed === null;
    var enabledCount = allOn ? group.tools.length : group.allowed.length;

    var headerLeft = document.createElement('div');
    headerLeft.className = 'tool-header-left';
    headerLeft.textContent = group.label;

    var countSpan = document.createElement('span');
    countSpan.className = 'tool-count' + (enabledCount === group.tools.length ? ' all-on' : '');
    countSpan.textContent = enabledCount + ' / ' + group.tools.length + (enabledCount === group.tools.length ? ' \u2713' : '');
    headerLeft.appendChild(countSpan);

    var arrow = document.createElement('span');
    arrow.className = 'tool-arrow';
    arrow.textContent = '\u25B6';

    header.appendChild(headerLeft);
    header.appendChild(arrow);

    // Body
    var body = document.createElement('div');
    body.className = 'tool-body';

    // Select all / Deselect all
    var selectAllDiv = document.createElement('div');
    selectAllDiv.className = 'tool-select-all';
    var selectAllSpan = document.createElement('span');
    selectAllSpan.textContent = enabledCount === group.tools.length ? 'Deselect all' : 'Select all';
    selectAllDiv.appendChild(selectAllSpan);
    body.appendChild(selectAllDiv);

    // Tool rows
    var checkboxes = [];
    group.tools.forEach(function(tool) {
      var row = document.createElement('div');
      row.className = 'tool-row';
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = allOn || group.allowed.indexOf(tool.name) >= 0;
      cb.dataset.toolName = tool.name;
      cb.dataset.toolField = group.field;
      checkboxes.push(cb);
      var nameSpan = document.createElement('span');
      nameSpan.className = 'tool-name' + (cb.checked ? '' : ' disabled');
      nameSpan.textContent = tool.name;
      var descSpan = document.createElement('span');
      descSpan.className = 'tool-desc';
      descSpan.textContent = tool.description || '';
      row.appendChild(cb);
      row.appendChild(nameSpan);
      row.appendChild(descSpan);

      cb.addEventListener('change', function() {
        nameSpan.className = 'tool-name' + (cb.checked ? '' : ' disabled');
        updateToolCount(countSpan, checkboxes, group.tools.length);
        updateSelectAllText(selectAllSpan, checkboxes);
      });

      body.appendChild(row);
    });

    // Select all click handler
    selectAllSpan.addEventListener('click', function() {
      var allChecked = checkboxes.every(function(c) { return c.checked; });
      checkboxes.forEach(function(c) {
        c.checked = !allChecked;
        var nameEl = c.parentElement.querySelector('.tool-name');
        if (nameEl) nameEl.className = 'tool-name' + (c.checked ? '' : ' disabled');
      });
      updateToolCount(countSpan, checkboxes, group.tools.length);
      updateSelectAllText(selectAllSpan, checkboxes);
    });

    // Toggle expand/collapse
    header.addEventListener('click', function() {
      var expanded = body.classList.toggle('expanded');
      arrow.textContent = expanded ? '\u25BC' : '\u25B6';
    });

    section.appendChild(header);
    section.appendChild(body);
    container.appendChild(section);
  });
}

function updateToolCount(countSpan, checkboxes, total) {
  var enabled = checkboxes.filter(function(c) { return c.checked; }).length;
  countSpan.textContent = enabled + ' / ' + total + (enabled === total ? ' \u2713' : '');
  countSpan.className = 'tool-count' + (enabled === total ? ' all-on' : '');
}

function updateSelectAllText(span, checkboxes) {
  var allChecked = checkboxes.every(function(c) { return c.checked; });
  span.textContent = allChecked ? 'Deselect all' : 'Select all';
}

function collectToolPickerState(containerId) {
  var container = document.getElementById(containerId);
  if (!container) return { allowedBuiltinTools: null, allowedMcpTools: null };
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
    allowedMcpTools: mcpAll ? null : mcpList,
  };
}
```

- [ ] **Step 5: Wire tool picker into init and edit handlers**

In the `setUpdateListener` callback, find where `type === 'init'` is handled. After setting up the existing agents list and draft fields, add:

```javascript
      // Store available tools for rendering pickers
      availableBuiltinTools = d.availableBuiltinTools || [];
      availableMcpTools = d.availableMcpTools || [];
      // Render the create-form tool picker (all enabled by default)
      renderToolPicker('create-tool-picker', null, null);
```

In the `type === 'edit'` handler, after populating the edit form fields, add:

```javascript
      availableBuiltinTools = d.availableBuiltinTools || [];
      availableMcpTools = d.availableMcpTools || [];
      renderToolPicker('edit-tool-picker',
        d.draft.allowedBuiltinTools !== undefined ? d.draft.allowedBuiltinTools : null,
        d.draft.allowedMcpTools !== undefined ? d.draft.allowedMcpTools : null,
      );
```

- [ ] **Step 6: Wire tool picker state into create() and saveEdit() payloads**

In the `create()` function, before sending the `sendUpdate`, collect the tool state:

```javascript
    var toolState = collectToolPickerState('create-tool-picker');
```

Then add `allowedBuiltinTools` and `allowedMcpTools` to the `sendUpdate` payload:

```javascript
    window.webxdc.sendUpdate({payload: {
      type: 'create',
      config: { name: n, model: m, system: s, tools: [] },
      skipPermissions: sp,
      allowedBuiltinTools: toolState.allowedBuiltinTools,
      allowedMcpTools: toolState.allowedMcpTools,
      senderAddr: window.webxdc.selfAddr,
    }}, 'create');
```

In the `saveEdit()` function, similarly:

```javascript
    var toolState = collectToolPickerState('edit-tool-picker');
```

Add to the saveEdit payload:

```javascript
    window.webxdc.sendUpdate({payload: {
      type: 'saveEdit',
      agentId: editingAgentId,
      config: { name: n, model: m, system: s, tools: [] },
      skipPermissions: sp,
      iconMirror: im,
      allowedBuiltinTools: toolState.allowedBuiltinTools,
      allowedMcpTools: toolState.allowedMcpTools,
      senderAddr: window.webxdc.selfAddr,
    }}, 'save');
```

- [ ] **Step 7: Bump APP_VERSION**

Find `var APP_VERSION =` in the HTML and increment it (e.g., from `1.32` to `1.33`). The builder reads this automatically.

- [ ] **Step 8: Run full test suite**

Run: `cd plugin && bun test`
Expected: PASS (the `webxdc-sender-addr.test.ts` test should still pass since `senderAddr` is included in all `sendUpdate` calls)

- [ ] **Step 9: Commit**

```bash
git add plugin/webxdc/agent-setup.html
git commit -m "feat(agent-setup): add collapsible tool picker UI (#16)"
```

---

### Task 6: Integration — End-to-end wiring verification

**Files:**
- No new files — this is a verification task

- [ ] **Step 1: Run full test suite**

Run: `cd plugin && bun test`
Expected: All tests PASS

- [ ] **Step 2: Verify YAML round-trip**

Write a quick manual test in the Bun REPL:

```bash
cd plugin && bun -e "
const agents = require('./agents');
const { mkdtempSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const dir = mkdtempSync(join(tmpdir(), 'agent-test-'));
agents.setAgentsDir(dir);
const a = { id: 'test-rt', name: 'Test', model: 'claude-sonnet-4-6', description: '', system: '', tools: [], allowedBuiltinTools: ['Read', 'Glob'], allowedMcpTools: ['reply'] };
agents.saveAgent(a);
const loaded = agents.getAgent('test-rt');
console.log('builtin:', loaded.allowedBuiltinTools);
console.log('mcp:', loaded.allowedMcpTools);
console.log('PASS:', JSON.stringify(loaded.allowedBuiltinTools) === '[\"Read\",\"Glob\"]' && JSON.stringify(loaded.allowedMcpTools) === '[\"reply\"]');
"
```
Expected: `PASS: true`

- [ ] **Step 3: Verify buildSubagentArgs respects allowedBuiltinTools**

```bash
cd plugin && bun -e "
const { buildSubagentArgs } = require('./dispatcher/subagent-process');
const opts = { chatId: 1, subagentId: 's1', settingsPath: '/tmp/s.json', dispatcherSocket: '/tmp/sock', dispatcherSecret: 'x', sessionId: 'id1', resume: false, mcpConfigPath: '/tmp/m.json', allowedBuiltinTools: ['Read', 'Glob'] };
const { args } = buildSubagentArgs(opts);
const i = args.indexOf('--allowedTools');
const list = args[i+1];
console.log('allowedTools:', list);
console.log('has Read:', list.includes('Read'));
console.log('has Glob:', list.includes('Glob'));
console.log('no Bash:', !list.includes('Bash'));
console.log('has mcp__dc:', list.includes('mcp__dc'));
"
```
Expected: Read and Glob present, Bash absent, mcp__dc present

- [ ] **Step 4: Commit (if any fixes needed)**

Only if step 1-3 revealed issues that required fixes.

---

### Task 7: Update CLAUDE.md documentation

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add tool access documentation**

In the repo-root `CLAUDE.md`, find the paragraph starting with "**Forward compat:**" (after the import/export section). Replace it with:

```markdown
**Per-agent tool access (v0.10+):** Each agent definition can restrict
which built-in tools and MCP tools its subagent is allowed to use via
two optional fields: `allowedBuiltinTools` (string array or null) and
`allowedMcpTools` (string array or null). `null` or absent means "all
tools allowed" (the default for new agents); `[]` means "no tools."
Restrictions are enforced at spawn time: built-in tools via
`--allowedTools` CLI flag, MCP tools via manifest filtering.
The agent-setup WebXDC card includes a collapsible tool picker grouped
by source (Built-in Tools, DC Tools) for visual configuration.
Changes take effect on next subagent spawn (idle timeout or restart).

**Forward compat:** the `tools: []` field is written on every agent as
a no-op hook. Per-agent tool capability restrictions use the separate
`allowedBuiltinTools` and `allowedMcpTools` fields instead.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document per-agent tool access in CLAUDE.md (#16)"
```
