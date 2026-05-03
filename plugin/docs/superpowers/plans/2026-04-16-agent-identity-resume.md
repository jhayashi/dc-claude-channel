# Agent Identity Across DC↔Terminal Resume — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve agent identity (model, agentId) when sessions cross the DC↔Terminal boundary, so a round-trip (DC → terminal → DC) rebinds to the original agent instead of copying from the source chat.

**Architecture:** A persistent `sessionId → agentId` reverse index (JSON file) is written whenever a binding is created or updated. `resume_attach` looks up the original agent by sessionId. `buildResumeCommand` includes `--model <model>` in the emitted command. The index survives binding deletion (dc_resume_in_terminal cleanup) so the mapping is available when the session returns to DC.

**Tech Stack:** TypeScript/Bun, JSON file storage, existing bindings/agents/resume modules.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `plugin/session-agents.ts` | **Create** | Persistent `sessionId → agentId` index. Read/write/delete/list. |
| `plugin/test/session-agents.test.ts` | **Create** | Unit tests for the index module. |
| `plugin/resume.ts` | **Modify** | `buildResumeCommand` adds `--model` flag; types updated. |
| `plugin/test/resume.test.ts` | **Modify** | Tests for `--model` in resume command. |
| `plugin/bindings.ts` | **Modify** | `saveBinding` and `bindAgent` write to session-agents index. |
| `plugin/test/bindings.test.ts` | **Modify** | Tests for index write on bind. |
| `plugin/apps/agent-setup-app.ts` | **Modify** | `resume_attach` reads index for agentId instead of copying source. |
| `plugin/server.ts` | **Modify** | `dc_resume_in_terminal` writes index before deleting binding. |

---

### Task 1: Session-Agents Index Module

**Files:**
- Create: `plugin/session-agents.ts`
- Create: `plugin/test/session-agents.test.ts`

This is a tiny persistence module: a JSON file mapping `sessionId → agentId`. Written whenever a session is bound to an agent. Read by `resume_attach` to recover the original agent. Survives binding deletion.

- [ ] **Step 1: Write the failing tests**

```typescript
// plugin/test/session-agents.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as sessionAgents from '../session-agents.js'

describe('session-agents index', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'session-agents-test-'))
    sessionAgents.setIndexDir(tmpDir)
  })

  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }))

  it('returns null for unknown sessionId', () => {
    expect(sessionAgents.getAgentForSession('nonexistent')).toBeNull()
  })

  it('stores and retrieves a sessionId → agentId mapping', () => {
    sessionAgents.setAgentForSession('sess-1', 'marketing-agent')
    expect(sessionAgents.getAgentForSession('sess-1')).toBe('marketing-agent')
  })

  it('overwrites an existing mapping', () => {
    sessionAgents.setAgentForSession('sess-1', 'old-agent')
    sessionAgents.setAgentForSession('sess-1', 'new-agent')
    expect(sessionAgents.getAgentForSession('sess-1')).toBe('new-agent')
  })

  it('supports multiple independent mappings', () => {
    sessionAgents.setAgentForSession('sess-1', 'agent-a')
    sessionAgents.setAgentForSession('sess-2', 'agent-b')
    expect(sessionAgents.getAgentForSession('sess-1')).toBe('agent-a')
    expect(sessionAgents.getAgentForSession('sess-2')).toBe('agent-b')
  })

  it('persists across reload (re-read from disk)', () => {
    sessionAgents.setAgentForSession('sess-1', 'agent-a')
    // Force a fresh read by setting the dir again
    sessionAgents.setIndexDir(tmpDir)
    expect(sessionAgents.getAgentForSession('sess-1')).toBe('agent-a')
  })

  it('removeSession deletes a mapping', () => {
    sessionAgents.setAgentForSession('sess-1', 'agent-a')
    sessionAgents.removeSession('sess-1')
    expect(sessionAgents.getAgentForSession('sess-1')).toBeNull()
  })

  it('removeSession is a no-op for unknown sessions', () => {
    expect(() => sessionAgents.removeSession('nonexistent')).not.toThrow()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/session-agents.test.ts`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 3: Write the implementation**

```typescript
// plugin/session-agents.ts
/**
 * Persistent sessionId → agentId reverse index.
 *
 * Written whenever a session is bound to an agent (via bindings.saveBinding
 * or bindings.bindAgent). Read by resume_attach to recover the original
 * agent when a session crosses the DC↔terminal boundary. Survives binding
 * deletion so the mapping is available when a session returns to DC.
 *
 * Stored as a single JSON file: ~/.claude/channels/deltachat/session-agents.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

let INDEX_DIR = join(homedir(), '.claude', 'channels', 'deltachat')
let cache: Record<string, string> | null = null

/** Override the storage directory (for tests). */
export function setIndexDir(dir: string): void {
  INDEX_DIR = dir
  cache = null
}

function indexPath(): string {
  return join(INDEX_DIR, 'session-agents.json')
}

function load(): Record<string, string> {
  if (cache) return cache
  const p = indexPath()
  if (!existsSync(p)) {
    cache = {}
    return cache
  }
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8'))
    cache = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}
  } catch {
    cache = {}
  }
  return cache
}

function persist(): void {
  const data = load()
  mkdirSync(INDEX_DIR, { recursive: true })
  const p = indexPath()
  const tmp = `${p}.tmp.${process.pid}`
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  renameSync(tmp, p)
}

export function getAgentForSession(sessionId: string): string | null {
  return load()[sessionId] ?? null
}

export function setAgentForSession(sessionId: string, agentId: string): void {
  load()[sessionId] = agentId
  persist()
}

export function removeSession(sessionId: string): void {
  const data = load()
  if (sessionId in data) {
    delete data[sessionId]
    persist()
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/session-agents.test.ts`
Expected: All 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add plugin/session-agents.ts plugin/test/session-agents.test.ts
git commit -m "feat(session-agents): persistent sessionId→agentId reverse index"
```

---

### Task 2: Write Index on Binding Save

**Files:**
- Modify: `plugin/bindings.ts` — import session-agents, write index in `saveBinding` and `bindAgent`
- Modify: `plugin/test/bindings.test.ts` — test that index is written

When a binding with both `sessionId` and `agentId` is saved, also write the mapping to the session-agents index.

- [ ] **Step 1: Write the failing test**

Add to `plugin/test/bindings.test.ts`, inside the existing describe block that has `beforeEach`/`afterEach` managing temp dirs:

```typescript
import * as sessionAgents from '../session-agents.js'

// In the beforeEach that creates tmpRoot:
// Add: sessionAgents.setIndexDir(tmpRoot)

it('saveBinding writes sessionId→agentId to session-agents index', () => {
  bindings.saveBinding({
    chatId: 10,
    agentId: 'marketing-agent',
    sessionId: 'sess-abc',
    createdAt: new Date().toISOString(),
  })
  expect(sessionAgents.getAgentForSession('sess-abc')).toBe('marketing-agent')
})

it('saveBinding skips index write when sessionId or agentId is missing', () => {
  bindings.saveBinding({
    chatId: 11,
    agentId: 'some-agent',
    createdAt: new Date().toISOString(),
  })
  // No sessionId → nothing written
  bindings.saveBinding({
    chatId: 12,
    sessionId: 'sess-xyz',
    createdAt: new Date().toISOString(),
  })
  // No agentId → nothing written
  expect(sessionAgents.getAgentForSession('sess-xyz')).toBeNull()
})

it('bindAgent writes to session-agents index when sessionId exists', () => {
  // Pre-create a binding with a sessionId but no agentId
  bindings.saveBinding({
    chatId: 13,
    sessionId: 'sess-pre',
    createdAt: new Date().toISOString(),
  })
  // Bind an agent — should write sessionId→agentId
  bindings.bindAgent(13, 'coach', { inheritClaudeMd: true })
  expect(sessionAgents.getAgentForSession('sess-pre')).toBe('coach')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/bindings.test.ts`
Expected: FAIL — session-agents index isn't populated by saveBinding yet.

- [ ] **Step 3: Add the index write to bindings.ts**

In `plugin/bindings.ts`, add the import at the top:

```typescript
import * as sessionAgents from './session-agents.js'
```

In `saveBinding`, after the `renameSync` call, add:

```typescript
if (validated.sessionId && validated.agentId) {
  sessionAgents.setAgentForSession(validated.sessionId, validated.agentId)
}
```

No changes needed to `bindAgent` — it already calls `saveBinding` internally with both fields populated.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/bindings.test.ts`
Expected: All tests PASS (existing + new).

- [ ] **Step 5: Run full test suite**

Run: `bun test`
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add plugin/bindings.ts plugin/test/bindings.test.ts
git commit -m "feat(bindings): write session-agents index on saveBinding"
```

---

### Task 3: Add `--model` to Resume Command

**Files:**
- Modify: `plugin/resume.ts` — `buildResumeCommand` accepts optional model, appends `--model`
- Modify: `plugin/test/resume.test.ts` — test the `--model` flag
- Modify: `plugin/server.ts` — pass the agent's model to `buildResumeCommand`

- [ ] **Step 1: Write the failing test**

Add to `plugin/test/resume.test.ts`, inside the `buildResumeCommand` describe block:

```typescript
it('includes --model flag when model is provided', () => {
  const sessionId = 'model-test-uuid'
  const workingDir = '/home/user/project'
  writeSessionFile(workingDir, sessionId)
  bindings.saveBinding({
    chatId: 200,
    sessionId,
    workingDir,
    createdAt: new Date().toISOString(),
  })
  const result = resume.buildResumeCommand(200, { model: 'claude-opus-4-6' })
  expect('command' in result).toBe(true)
  if ('command' in result) {
    expect(result.command).toContain('--model claude-opus-4-6')
    expect(result.command).toContain('--resume model-test-uuid')
  }
})

it('omits --model flag when model is not provided', () => {
  const sessionId = 'no-model-uuid'
  const workingDir = '/home/user/project2'
  writeSessionFile(workingDir, sessionId)
  bindings.saveBinding({
    chatId: 201,
    sessionId,
    workingDir,
    createdAt: new Date().toISOString(),
  })
  const result = resume.buildResumeCommand(201)
  expect('command' in result).toBe(true)
  if ('command' in result) {
    expect(result.command).not.toContain('--model')
  }
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/resume.test.ts`
Expected: First test FAIL — `model` not in opts type yet.

- [ ] **Step 3: Update buildResumeCommand to accept and emit --model**

In `plugin/resume.ts`, update the `buildResumeCommand` function:

```typescript
export function buildResumeCommand(
  chatId: number,
  opts: { cwd?: string; chatName?: string; model?: string } = {},
): ResumeCommand | ResumeError {
  // ... existing binding/session lookup unchanged ...

  const nameFlag = opts.chatName ? ` --name ${shellQuote(opts.chatName)}` : ''
  const modelFlag = opts.model ? ` --model ${opts.model}` : ''
  return {
    command: `cd ${cwd} && claude --resume ${sessionId}${modelFlag}${nameFlag}`,
    sessionId,
    sessionPath,
    sessionName: opts.chatName ?? null,
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/resume.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Pass the agent model in server.ts**

In `plugin/server.ts`, in the `dc_resume_in_terminal` handler (around line 1407), resolve the agent and pass its model:

Change:
```typescript
const result = resume.buildResumeCommand(chatId, { chatName })
```

To:
```typescript
const resolved = bindings.resolveChat(chatId)
const result = resume.buildResumeCommand(chatId, {
  chatName,
  model: resolved?.agent.model,
})
```

`resolveChat` is already imported from `plugin/bindings.ts` and returns `{ binding, agent } | null`.

- [ ] **Step 6: Run full test suite**

Run: `bun test`
Expected: All tests PASS.

- [ ] **Step 7: Commit**

```bash
git add plugin/resume.ts plugin/test/resume.test.ts plugin/server.ts
git commit -m "feat(resume): include --model in dc_resume_in_terminal command"
```

---

### Task 4: Preserve Index on dc_resume_in_terminal Cleanup

**Files:**
- Modify: `plugin/server.ts` — do NOT delete session-agents entry in cleanup

The `dc_resume_in_terminal` cleanup deletes the binding (line 1437). Since `saveBinding` now writes to the session-agents index, and `deleteBinding` does NOT remove from the index, the mapping naturally survives. This task is a verification-only step — no code changes needed, but we confirm the invariant.

- [ ] **Step 1: Verify deleteBinding does NOT touch session-agents**

Read `plugin/bindings.ts` `deleteBinding` function. Confirm it only calls `unlinkSync` on the binding file and does not call `sessionAgents.removeSession`. This is correct — we WANT the mapping to survive binding deletion so terminal→DC can look it up later.

- [ ] **Step 2: Verify with a manual trace**

Trace the dc_resume_in_terminal flow:
1. `saveBinding` was called when chat was created → wrote `sessionId → agentId` to index ✓
2. `buildResumeCommand` now includes `--model` ✓
3. Cleanup calls `bindings.deleteBinding(chatId)` → removes binding JSON, index untouched ✓
4. Later, `resume_attach` can look up `sessionAgents.getAgentForSession(sessionId)` → finds original agentId ✓

No code changes needed. Move on.

- [ ] **Step 3: Commit (no-op, skip)**

No changes to commit.

---

### Task 5: Use Index in resume_attach

**Files:**
- Modify: `plugin/apps/agent-setup-app.ts` — `resume_attach` handler reads session-agents index

This is the key change: instead of `const agentId = sourceBinding?.agentId ?? 'claude-code'`, look up the session's original agent from the index first.

- [ ] **Step 1: Identify the code to change**

In `plugin/apps/agent-setup-app.ts`, the `resume_attach` handler (around line 694-695):

```typescript
const sourceBinding = bindings.getBinding(session.sourceChatId)
const agentId = sourceBinding?.agentId ?? 'claude-code'
```

- [ ] **Step 2: Update to prefer session-agents index**

Add the import at the top of the file:

```typescript
import * as sessionAgents from '../session-agents.js'
```

Replace the agent resolution (lines 694-696):

```typescript
// Prefer the session's original agent (from the reverse index) over the
// source chat's agent. Falls back to source chat → default agent.
const indexedAgentId = sessionAgents.getAgentForSession(sessionId)
const sourceBinding = bindings.getBinding(session.sourceChatId)
const agentId = indexedAgentId ?? sourceBinding?.agentId ?? 'claude-code'
const agent = agents.getAgent(agentId)
```

The `?? sourceBinding?.agentId` fallback covers terminal-origin sessions that were never in DC (no index entry). The `?? 'claude-code'` fallback covers the case where neither exists.

Also log the resolution for debugging:

```typescript
ctx.logf('agent-setup: resume agent resolution: indexed=%s source=%s resolved=%s',
  indexedAgentId ?? 'none', sourceBinding?.agentId ?? 'none', agentId)
```

- [ ] **Step 3: Run full test suite**

Run: `bun test`
Expected: All tests PASS.

- [ ] **Step 4: Commit**

```bash
git add plugin/apps/agent-setup-app.ts
git commit -m "feat(resume): use session-agents index in resume_attach"
```

---

### Task 6: Integration Smoke Test

**Files:** None (manual test)

- [ ] **Step 1: Restart dispatcher**

```bash
# In the terminal running bun server.ts: Ctrl-C, then re-run
bun server.ts
```

- [ ] **Step 2: Test DC → Terminal preserves model**

1. Open a chat bound to a non-default agent (e.g. one using `claude-opus-4-6`)
2. Ask the agent to "teleport to terminal"
3. Verify the emitted command includes `--model claude-opus-4-6`

- [ ] **Step 3: Test Terminal → DC preserves agent**

1. Open the settings app from any chat
2. Go to "Resume a conversation"
3. Pick a session that was previously in a DC chat with a specific agent
4. Attach it
5. Verify the new chat is bound to the **original** agent, not the source chat's agent

- [ ] **Step 4: Test round-trip**

1. Create a chat with "Coach" agent
2. Send a message (creates session)
3. Teleport to terminal → verify `--model` matches Coach's model
4. Resume back into DC from a different chat (e.g. DC Coding)
5. Verify the new chat is bound to "Coach", not "DC Coding"

- [ ] **Step 5: Test fallback for terminal-origin sessions**

1. Start a fresh `claude` session in terminal (never been in DC)
2. Resume it into DC via the settings app
3. Verify it falls back to the source chat's agent (no index entry exists)
