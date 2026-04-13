# Agent Import/Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users import agent definitions by sending `.yaml` files into a DC chat, and export agents via the agent-setup WebXDC card — zero model tokens, pure dispatcher logic.

**Architecture:** Import is handled by attachment detection in `server.ts` before the message reaches the subagent. Export is a new `'export'` case in the agent-setup app's `onWebXDCUpdate` handler. Both use the existing `agents.ts` API. A new `importAgentFromYaml()` helper in `agents.ts` encapsulates parse → validate → ID-resolution → save.

**Tech Stack:** TypeScript/Bun, `yaml` library (already a dependency), Zod validation, Delta Chat RPC (`sendAttachment`), WebXDC.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `plugin/agents.ts` | Modify | Add `importAgentFromYaml()` helper |
| `plugin/test/agents.test.ts` | Modify | Tests for import helper |
| `plugin/server.ts` | Modify | Attachment interception before subagent dispatch |
| `plugin/apps/agent-setup-app.ts` | Modify | Handle `'export'` WebXDC update type |
| `plugin/webxdc/agent-setup.html` | Modify | Add Export button + `exportAgent()` function, bump `APP_VERSION` |

---

## Task 1: `importAgentFromYaml` helper — tests + implementation

**Files:**
- Modify: `plugin/test/agents.test.ts`
- Modify: `plugin/agents.ts`

The import helper is a pure function: takes a YAML string, returns the saved agent definition and whether the ID was changed. This is the core logic that both the attachment handler and any future import path can call.

- [ ] **Step 1: Write the failing tests**

Add this `describe` block at the bottom of `plugin/test/agents.test.ts`:

```typescript
describe('importAgentFromYaml', () => {
  test('imports a valid YAML string and saves the agent', () => {
    const yaml = [
      'id: imported-agent',
      'name: Imported Agent',
      'model: claude-sonnet-4-6',
      'system: you are helpful',
      'tools: []',
    ].join('\n')
    const result = agents.importAgentFromYaml(yaml)
    expect(result.agent.id).toBe('imported-agent')
    expect(result.agent.name).toBe('Imported Agent')
    expect(result.idChanged).toBe(false)
    expect(agents.getAgent('imported-agent')).toBeTruthy()
  })

  test('synthesizes id from name when id is missing', () => {
    const yaml = [
      'name: My Cool Agent',
      'model: claude-sonnet-4-6',
      'system: be cool',
      'tools: []',
    ].join('\n')
    const result = agents.importAgentFromYaml(yaml)
    expect(result.agent.id).toBe('my-cool-agent')
    expect(result.idChanged).toBe(false)
    expect(agents.getAgent('my-cool-agent')).toBeTruthy()
  })

  test('auto-suffixes when id collides with existing agent', () => {
    agents.saveAgent(makeDef({ id: 'collider', name: 'Collider' }))
    const yaml = [
      'id: collider',
      'name: Collider Clone',
      'model: claude-sonnet-4-6',
      'system: clone',
      'tools: []',
    ].join('\n')
    const result = agents.importAgentFromYaml(yaml)
    expect(result.agent.id).toBe('collider-2')
    expect(result.idChanged).toBe(true)
    expect(agents.getAgent('collider-2')).toBeTruthy()
  })

  test('auto-suffixes when synthesized id collides', () => {
    agents.saveAgent(makeDef({ id: 'dupe-name', name: 'Dupe Name' }))
    const yaml = [
      'name: Dupe Name',
      'model: claude-sonnet-4-6',
      'system: dupe',
      'tools: []',
    ].join('\n')
    const result = agents.importAgentFromYaml(yaml)
    expect(result.agent.id).toBe('dupe-name-2')
    expect(result.idChanged).toBe(true)
  })

  test('preserves metadata including x-dc-* extensions', () => {
    const yaml = [
      'id: meta-agent',
      'name: Meta Agent',
      'model: claude-sonnet-4-6',
      'system: meta',
      'tools: []',
      'metadata:',
      '  x-dc-skipPermissions: true',
      '  x-dc-iconMirror: true',
      '  custom-key: custom-value',
    ].join('\n')
    const result = agents.importAgentFromYaml(yaml)
    expect(result.agent.metadata).toEqual({
      'x-dc-skipPermissions': true,
      'x-dc-iconMirror': true,
      'custom-key': 'custom-value',
    })
  })

  test('throws on invalid YAML', () => {
    expect(() => agents.importAgentFromYaml('{not: [valid yaml')).toThrow()
  })

  test('throws on valid YAML that fails schema validation', () => {
    const yaml = [
      'id: bad-model',
      'name: Bad Model',
      'model: gpt-4',
      'system: nope',
      'tools: []',
    ].join('\n')
    expect(() => agents.importAgentFromYaml(yaml)).toThrow()
  })

  test('throws when name is missing', () => {
    const yaml = [
      'id: no-name',
      'model: claude-sonnet-4-6',
      'system: nope',
      'tools: []',
    ].join('\n')
    expect(() => agents.importAgentFromYaml(yaml)).toThrow()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugin && bun test test/agents.test.ts`
Expected: FAIL — `agents.importAgentFromYaml is not a function`

- [ ] **Step 3: Extract `slugifyName` helper in `plugin/agents.ts`**

The slugification logic in `synthesizeAgentId` needs to be reusable so `importAgentFromYaml` can detect whether a synthesized id was collision-suffixed. Extract a pure helper and refactor `synthesizeAgentId` to use it.

Find the existing `synthesizeAgentId` function (lines 227–244):

```typescript
export function synthesizeAgentId(name: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'agent'
  if (!existsSync(AGENTS_DIR)) return base
```

Add the helper BEFORE `synthesizeAgentId` and refactor:

```typescript
/** Pure name → slug conversion — no collision check. */
export function slugifyName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'agent'
  )
}

/**
 * Synthesize a slug-based agent id from a name, resolving collisions by
 * suffixing -2, -3, etc. The result always matches AgentDefSchema.id.
 */
export function synthesizeAgentId(name: string): string {
  const base = slugifyName(name)
  if (!existsSync(AGENTS_DIR)) return base
```

This is a pure refactor — `synthesizeAgentId` behavior is unchanged.

- [ ] **Step 4: Implement `importAgentFromYaml` in `plugin/agents.ts`**

Add this after the refactored `synthesizeAgentId` function:

```typescript
/**
 * Result of importing an agent from YAML.
 */
export interface ImportResult {
  agent: AgentDef
  idChanged: boolean
}

/**
 * Parse a YAML string as an agent definition, resolve ID collisions,
 * and persist. Throws on parse/validation failure.
 *
 * If the YAML has no `id` field, one is synthesized from `name`.
 * If the id (provided or synthesized) collides with an existing agent,
 * a `-2`, `-3`, etc. suffix is appended and `idChanged` is set.
 */
export function importAgentFromYaml(yamlStr: string): ImportResult {
  const raw = YAML.parse(yamlStr)
  if (!raw || typeof raw !== 'object') {
    throw new Error('YAML did not produce an object')
  }

  const hasExplicitId = typeof raw.id === 'string' && raw.id.length > 0

  if (!hasExplicitId) {
    // Validate without id to catch missing name early, then synthesize.
    AgentDefSchema.omit({ id: true }).parse(raw)
    raw.id = synthesizeAgentId(raw.name)
  }

  // Validate the full schema now that id is present.
  const validated = AgentDefSchema.parse(raw)

  let finalId = validated.id
  let idChanged = false

  if (hasExplicitId && getAgent(finalId)) {
    // Explicit id collides — suffix it directly.
    const base = finalId
    let n = 2
    while (getAgent(`${base}-${n}`)) n++
    finalId = `${base}-${n}`
    idChanged = true
  } else if (!hasExplicitId) {
    // synthesizeAgentId already resolved collisions — detect whether
    // it suffixed by comparing with the bare slug.
    const bareSlug = slugifyName(validated.name)
    if (finalId !== bareSlug) idChanged = true
  }

  const agent: AgentDef = { ...validated, id: finalId }
  saveAgent(agent)
  return { agent, idChanged }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd plugin && bun test test/agents.test.ts`
Expected: all tests PASS

- [ ] **Step 6: Commit**

```bash
git add plugin/agents.ts plugin/test/agents.test.ts
git commit -m "feat(agents): importAgentFromYaml helper with collision handling (#15)"
```

---

## Task 2: Attachment interception in `server.ts`

**Files:**
- Modify: `plugin/server.ts`

When a paired, authorized message arrives with a `.yaml`/`.yml` file attachment, intercept it before the subagent. On valid import: send confirmation, skip the subagent turn. On invalid: send error, still forward to the subagent.

- [ ] **Step 1: Read the current `runSubagentTurn` function**

Read `plugin/server.ts` lines 1429–1461 to understand the attachment interception point. Note that `server.ts` already has `import * as agents from './agents.js'`, so `agents.importAgentFromYaml()` is accessible without any new imports.

- [ ] **Step 2: Add the `tryImportAgentAttachment` helper in `server.ts`**

Add this function before `runSubagentTurn` (around line 1428):

```typescript
/**
 * If the message has a .yaml/.yml file attachment, attempt to import it
 * as an agent definition. Returns true if the attachment was handled
 * (import succeeded or failed with an error message sent). Returns
 * false if no .yaml attachment present — the message should proceed
 * to the subagent normally.
 */
const tryImportAgentAttachment = async (msg: Message): Promise<boolean> => {
  if (!msg.file || !msg.fileName) return false
  const lower = msg.fileName.toLowerCase()
  if (!lower.endsWith('.yaml') && !lower.endsWith('.yml')) return false

  const chatId = msg.chatId
  const MAX_IMPORT_BYTES = 256 * 1024

  try {
    if (msg.fileBytes && msg.fileBytes > MAX_IMPORT_BYTES) {
      await client.send(chatId, '\u26a0\ufe0f Agent import failed: file too large (max 256 KB).')
      return true
    }

    const { readFileSync } = await import('node:fs')
    const yamlStr = readFileSync(msg.file, 'utf-8')

    if (yamlStr.length > MAX_IMPORT_BYTES) {
      await client.send(chatId, '\u26a0\ufe0f Agent import failed: file too large (max 256 KB).')
      return true
    }

    const result = agents.importAgentFromYaml(yamlStr)
    const idNote = result.idChanged ? ` (saved as "${result.agent.id}" to avoid a name conflict)` : ''
    await client.send(
      chatId,
      `\u2705 Imported agent "${result.agent.name}"${idNote}. To create a chat with it, use the agent setup card.`,
    )
    logf('import: agent "%s" (id=%s) imported from attachment in chat %d', result.agent.name, result.agent.id, chatId)
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Truncate long Zod errors to keep the DC message short.
    const short = message.length > 200 ? message.slice(0, 200) + '...' : message
    await client.send(chatId, `\u26a0\ufe0f Couldn't import agent from "${msg.fileName}": ${short}`)
    logf('import: failed for chat %d file=%s: %v', chatId, msg.fileName, err)
    // Return false so the message still reaches the subagent — the user
    // may have sent the file as context for a conversation.
    return false
  }
}
```

- [ ] **Step 3: Wire the helper into `runSubagentTurn`**

In `runSubagentTurn`, add the interception at the very top of the function, before the cold-start spinner:

Find:
```typescript
const runSubagentTurn = async (msg: Message): Promise<void> => {
  const chatId = msg.chatId
  activityReactor.setTurnTarget(chatId, msg.id)
```

Replace with:
```typescript
const runSubagentTurn = async (msg: Message): Promise<void> => {
  // Intercept .yaml/.yml attachments as agent imports.
  if (await tryImportAgentAttachment(msg)) return

  const chatId = msg.chatId
  activityReactor.setTurnTarget(chatId, msg.id)
```

- [ ] **Step 4: Run all tests**

Run: `cd plugin && bun test`
Expected: all tests PASS (no functional tests for this wiring — it's integration-level; tested manually in Task 7)

- [ ] **Step 5: Commit**

```bash
git add plugin/server.ts
git commit -m "feat(import): intercept .yaml attachments as agent imports (#15)"
```

---

## Task 3: Export handler in `agent-setup-app.ts`

**Files:**
- Modify: `plugin/apps/agent-setup-app.ts`

Add a new `'export'` case in the `onWebXDCUpdate` handler that reads the agent definition, writes it to a temp YAML file, and sends it as a DC file attachment.

- [ ] **Step 1: Read the current onWebXDCUpdate handler**

Read `plugin/apps/agent-setup-app.ts` lines 249–600 to understand the payload handling pattern.

- [ ] **Step 2: Add the `'export'` case**

In `agent-setup-app.ts`, inside the `onWebXDCUpdate` method's `for (const u of updates)` loop, add this block after the `'delete'` case (after the `continue` on line 394) and before the `'saveEdit'` case:

```typescript
      if (payload.type === 'export') {
        const agentId = typeof payload.agentId === 'string' ? payload.agentId : ''
        if (!agentId) {
          ctx.logf('agent-setup: export payload missing agentId')
          continue
        }
        const agent = agents.getAgent(agentId)
        if (!agent) {
          ctx.logf('agent-setup: export requested agent %s not found', agentId)
          try {
            const update = JSON.stringify({
              payload: {
                type: 'exportError',
                message: 'Agent no longer exists.',
                version: agentSetup.getAgentSetupVersion(),
                senderAddr: 'server',
              },
              summary: 'Export failed',
            })
            await ctx.client.sendWebXDCUpdate(session.msgId, update)
          } catch (err) {
            ctx.logf('agent-setup: export error update failed: %v', err)
          }
          continue
        }
        try {
          const { writeFileSync, unlinkSync, mkdtempSync } = await import('node:fs')
          const { join } = await import('node:path')
          const { tmpdir } = await import('node:os')
          const YAML = (await import('yaml')).default

          const yamlStr = YAML.stringify(agent)
          const dir = mkdtempSync(join(tmpdir(), 'dc-agent-export-'))
          const filePath = join(dir, `${agentId}.yaml`)
          writeFileSync(filePath, yamlStr)

          await ctx.client.sendAttachment(
            session.sourceChatId,
            filePath,
            `Exported agent "${agent.name}"`,
          )
          ctx.logf('agent-setup: exported agent %s to chat %d', agentId, session.sourceChatId)

          // Notify the card so it can reset the button state.
          const update = JSON.stringify({
            payload: {
              type: 'exported',
              agentId,
              version: agentSetup.getAgentSetupVersion(),
              senderAddr: 'server',
            },
            summary: 'Agent exported',
          })
          await ctx.client.sendWebXDCUpdate(session.msgId, update)

          // Clean up temp file.
          try { unlinkSync(filePath) } catch {}
        } catch (err) {
          ctx.logf('agent-setup: export failed for agent %s: %v', agentId, err)
        }
        continue
      }
```

- [ ] **Step 3: Run all tests**

Run: `cd plugin && bun test`
Expected: all tests PASS

- [ ] **Step 4: Commit**

```bash
git add plugin/apps/agent-setup-app.ts
git commit -m "feat(export): handle 'export' WebXDC update in agent-setup (#15)"
```

---

## Task 4: Export button in `agent-setup.html` + version bump

**Files:**
- Modify: `plugin/webxdc/agent-setup.html`

Add an "Export" button to each agent card in the list view, a `exportAgent()` function, and a handler for the `'exported'`/`'exportError'` response types. Bump `APP_VERSION`.

- [ ] **Step 1: Add the `exportAgent` function**

In `plugin/webxdc/agent-setup.html`, add this function after the `deleteAgent` function (after line 494):

```javascript
function exportAgent(agentId) {
  window.webxdc.sendUpdate({
    payload: { type: 'export', agentId: agentId, senderAddr: window.webxdc.selfAddr },
    summary: 'Export agent: ' + agentId
  }, 'Export agent');
}
```

Note: this function does NOT set `creating = true` or guard on it, because export doesn't navigate away from the list view. The user can still interact with other buttons while the export is in flight.

- [ ] **Step 2: Add the Export button to `renderExistingList`**

In `plugin/webxdc/agent-setup.html`, inside the `renderExistingList` function, add the Export button after the Delete button (after line 352, before `btn.appendChild(actions)`):

Find:
```javascript
    var deleteBtn = document.createElement('button');
    deleteBtn.className = 'card-action-btn';
    deleteBtn.textContent = '\u2715 Delete';
    deleteBtn.onclick = (function(id){ return function(e){ e.stopPropagation(); deleteAgent(id); }; })(a.id);
    actions.appendChild(deleteBtn);
    btn.appendChild(actions);
```

Replace with:
```javascript
    var deleteBtn = document.createElement('button');
    deleteBtn.className = 'card-action-btn';
    deleteBtn.textContent = '\u2715 Delete';
    deleteBtn.onclick = (function(id){ return function(e){ e.stopPropagation(); deleteAgent(id); }; })(a.id);
    actions.appendChild(deleteBtn);
    var exportBtn = document.createElement('button');
    exportBtn.className = 'card-action-btn';
    exportBtn.textContent = '\u2B07 Export';
    exportBtn.onclick = (function(id){ return function(e){ e.stopPropagation(); exportAgent(id); }; })(a.id);
    actions.appendChild(exportBtn);
    btn.appendChild(actions);
```

- [ ] **Step 3: Handle the `'exported'` and `'exportError'` response types**

In the `setUpdateListener` handler (around line 510–550), add cases for the new response types. Find the section that handles different `d.type` values and add:

```javascript
      if (d.type === 'exported') {
        // Export succeeded — no navigation needed. Optionally show brief feedback.
        creating = false;
        return;
      }
      if (d.type === 'exportError') {
        creating = false;
        alert(d.message || 'Export failed.');
        return;
      }
```

- [ ] **Step 4: Bump `APP_VERSION`**

In `plugin/webxdc/agent-setup.html`, change:

```javascript
var APP_VERSION = 1.27;
```

to:

```javascript
var APP_VERSION = 1.28;
```

- [ ] **Step 5: Run all tests**

Run: `cd plugin && bun test`
Expected: all tests PASS (the existing `webxdc-sender-addr.test.ts` will auto-verify the new `sendUpdate` call includes `senderAddr`)

- [ ] **Step 6: Commit**

```bash
git add plugin/webxdc/agent-setup.html
git commit -m "feat(export): add Export button to agent-setup card (#15)"
```

---

## Task 5: Round-trip integration test

**Files:**
- Modify: `plugin/test/agents.test.ts`

Verify that exporting an agent to YAML and re-importing it produces an identical definition (except for an auto-suffixed ID on collision).

- [ ] **Step 1: Write the round-trip test**

Add this test inside the `importAgentFromYaml` describe block in `plugin/test/agents.test.ts`:

```typescript
  test('round-trip: export then import produces identical agent', () => {
    const original = makeDef({
      id: 'roundtrip-export',
      name: 'Roundtrip Export',
      description: 'A test agent for round-trip',
      system: 'be helpful and precise',
      metadata: { 'x-dc-skipPermissions': true, 'custom': 'value' },
    })
    agents.saveAgent(original)

    // Export: read the saved YAML (simulates what the export handler does).
    const exported = agents.getAgent('roundtrip-export')!
    const yamlStr = YAML.stringify(exported)

    // Delete the original so the import doesn't collide.
    agents.deleteAgent('roundtrip-export')

    // Import the exported YAML.
    const result = agents.importAgentFromYaml(yamlStr)
    expect(result.idChanged).toBe(false)
    expect(result.agent).toEqual(original)
  })

  test('round-trip with collision: import gets suffixed id', () => {
    const original = makeDef({
      id: 'rt-collide',
      name: 'RT Collide',
      system: 'original',
    })
    agents.saveAgent(original)

    const yamlStr = YAML.stringify(original)

    // Import without deleting — should get -2 suffix.
    const result = agents.importAgentFromYaml(yamlStr)
    expect(result.idChanged).toBe(true)
    expect(result.agent.id).toBe('rt-collide-2')
    expect(result.agent.name).toBe('RT Collide')
  })
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd plugin && bun test test/agents.test.ts`
Expected: all tests PASS

- [ ] **Step 3: Commit**

```bash
git add plugin/test/agents.test.ts
git commit -m "test(agents): round-trip export/import integration tests (#15)"
```

---

## Task 6: CLAUDE.md documentation update

**Files:**
- Modify: `CLAUDE.md`

Document the import/export feature in the Architecture section.

- [ ] **Step 1: Add documentation**

In `CLAUDE.md`, find the `## Agent model (v0.10+)` section. Add a new paragraph after the existing content about editing an agent definition (the paragraph starting "Editing an agent definition **mutates in place**"):

```markdown
**Import/export (v0.10+):** Agent definitions can be exported as `.yaml`
files via the agent-setup WebXDC card ("Export" button) and imported by
sending a `.yaml` file attachment into any paired DC chat. The dispatcher
intercepts `.yaml` attachments before the subagent sees them: valid
definitions are saved (with automatic ID collision resolution via `-2`,
`-3`, etc. suffixes); invalid YAML is rejected with an error message and
the attachment is forwarded to the subagent. Export sends the full agent
definition including `x-dc-*` metadata. Bindings (host-local chat
mappings) are not exported — the user creates a new chat via the
agent-setup card after importing. Round-trip compatible with Claude
Managed Agents API YAML format.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document agent import/export in CLAUDE.md (#15)"
```

---

## Task 7: Manual smoke test

No code changes. Verify the feature end-to-end after a dispatcher bounce.

- [ ] **Step 1: Bounce the dispatcher**

Restart `bun server.ts`.

- [ ] **Step 2: Test export**

Open the agent-setup card in a DC chat. Find an existing agent in the list. Tap "Export". Verify:
- A `.yaml` file attachment arrives in the chat
- The file contains a valid agent definition with all fields

- [ ] **Step 3: Test import**

Send the exported `.yaml` file back into the chat as an attachment. Verify:
- A confirmation message appears: `Imported agent "<name>" (saved as "<id>-2" to avoid a name conflict).`
- The agent appears in the agent-setup card's list

- [ ] **Step 4: Test invalid import**

Send a non-agent `.yaml` file (e.g., a random config file) into the chat. Verify:
- An error message appears with a concise reason
- The subagent still responds to any accompanying text

- [ ] **Step 5: Test round-trip on different instance**

Copy the exported `.yaml` to a second device/account. Send it as an attachment. Verify the agent imports successfully with its original ID (no collision).

- [ ] **Step 6: Test large file rejection**

Create a `.yaml` file larger than 256 KB and send it. Verify the size error message appears.
