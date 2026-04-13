# Familiar Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dynamic WebXDC app runtime ("Familiar") that lets Claude-authored apps use Claude as a live backend, with a bundled skill teaching subagents how to build both static and Familiar WebXDC apps.

**Architecture:** A single `WebXDCApp` implementation (`familiarApp`) hosts all dynamically-created Familiar apps. Claude generates HTML + a JS handler string; the runtime evals the handler in a restricted scope with `ctx.state`, `ctx.sendUpdate()`, and `ctx.requestLLM()`. Apps persist as JSON files in `~/.claude/channels/deltachat/familiars/`. A `.familiar.yaml` import flow mirrors the existing agent YAML import pattern.

**Tech Stack:** TypeScript/Bun, fflate (ZIP), nanoid (IDs), existing WebXDCApp interface + xdc-builder infrastructure.

**Security note:** The eval sandbox is an intentional design choice — Claude authors the handler code, the user approves app creation, and the handler API is intentionally minimal. Dangerous globals are explicitly shadowed.

---

## File Structure

| File | Responsibility | Action |
|------|---------------|--------|
| `plugin/familiar-runtime.ts` | Eval sandbox, handler registry, state persistence, YAML import validation | Create |
| `plugin/apps/familiar-app.ts` | WebXDCApp wrapper: tools, callTool, onWebXDCUpdate routing, start/stop | Create |
| `plugin/webxdc/familiar-manifest.toml` | Manifest for Familiar .xdc apps | Create |
| `plugin/apps.ts` | App registry | Modify (add familiarApp) |
| `plugin/server.ts` | .familiar.yaml attachment interception | Modify |
| `plugin/skills/webxdc-builder/SKILL.md` | Skill teaching subagents to build WebXDC apps | Create |
| `plugin/test/familiar-runtime.test.ts` | Unit tests for sandbox, state, persistence, YAML import | Create |
| `plugin/test/familiar-app.test.ts` | Integration tests for tools + update routing | Create |

---

### Task 1: Familiar Runtime Core — Eval Sandbox + State

**Files:**
- Create: `plugin/familiar-runtime.ts`
- Create: `plugin/test/familiar-runtime.test.ts`

- [ ] **Step 1: Write the failing test for sandbox execution**

Create `plugin/test/familiar-runtime.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test'
import { createSandbox, type SandboxContext } from '../familiar-runtime.ts'

describe('Familiar sandbox', () => {
  test('handler receives update and can call sendUpdate', async () => {
    const sent: unknown[] = []
    const ctx: SandboxContext = {
      state: {},
      sendUpdate: (payload) => { sent.push(payload) },
      requestLLM: async () => '',
      appId: 'test-1',
      chatId: 42,
    }

    const handler = `function handler(update, ctx) {
      ctx.state.count = (ctx.state.count || 0) + 1;
      ctx.sendUpdate({ type: 'ack', count: ctx.state.count });
    }`

    const fn = createSandbox(handler)
    await fn({ type: 'ping' }, ctx)

    expect(ctx.state).toEqual({ count: 1 })
    expect(sent).toEqual([{ type: 'ack', count: 1 }])
  })

  test('handler cannot access fs, process, or fetch', async () => {
    const ctx: SandboxContext = {
      state: {},
      sendUpdate: () => {},
      requestLLM: async () => '',
      appId: 'test-2',
      chatId: 42,
    }

    const handler = `function handler(update, ctx) {
      var blocked = [];
      if (typeof require !== 'undefined') blocked.push('require');
      if (typeof process !== 'undefined') blocked.push('process');
      if (typeof fetch !== 'undefined') blocked.push('fetch');
      if (typeof Bun !== 'undefined') blocked.push('Bun');
      ctx.sendUpdate({ blocked: blocked });
    }`

    const sent: unknown[] = []
    ctx.sendUpdate = (payload) => { sent.push(payload) }
    const fn = createSandbox(handler)
    await fn({ type: 'check' }, ctx)

    expect(sent).toEqual([{ blocked: [] }])
  })

  test('handler can use standard builtins (Math, JSON, Date, Array)', async () => {
    const sent: unknown[] = []
    const ctx: SandboxContext = {
      state: {},
      sendUpdate: (payload) => { sent.push(payload) },
      requestLLM: async () => '',
      appId: 'test-3',
      chatId: 42,
    }

    const handler = `function handler(update, ctx) {
      var arr = [3, 1, 2];
      arr.sort();
      ctx.sendUpdate({
        math: Math.max(1, 2, 3),
        json: JSON.parse('{"a":1}'),
        date: typeof Date,
        sorted: arr,
      });
    }`

    const fn = createSandbox(handler)
    await fn({ type: 'test' }, ctx)

    expect(sent[0]).toEqual({
      math: 3,
      json: { a: 1 },
      date: 'function',
      sorted: [1, 2, 3],
    })
  })

  test('handler errors are caught and do not crash', async () => {
    const ctx: SandboxContext = {
      state: {},
      sendUpdate: () => {},
      requestLLM: async () => '',
      appId: 'test-4',
      chatId: 42,
    }

    const handler = `function handler(update, ctx) {
      throw new Error('intentional');
    }`

    const fn = createSandbox(handler)
    const result = await fn({ type: 'boom' }, ctx)
    expect(result).toEqual({ error: 'intentional' })
  })

  test('requestLLM is callable from handler', async () => {
    const sent: unknown[] = []
    const ctx: SandboxContext = {
      state: {},
      sendUpdate: (payload) => { sent.push(payload) },
      requestLLM: async (prompt) => `Answer to: ${prompt}`,
      appId: 'test-5',
      chatId: 42,
    }

    const handler = `function handler(update, ctx) {
      var response = ctx.requestLLM('what is 2+2?');
      ctx.sendUpdate({ response: response });
    }`

    const fn = createSandbox(handler)
    await fn({ type: 'ask' }, ctx)

    expect(sent[0]).toEqual({ response: 'Answer to: what is 2+2?' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugin && bun test test/familiar-runtime.test.ts`
Expected: FAIL — `familiar-runtime.ts` does not exist.

- [ ] **Step 3: Implement the sandbox and runtime core**

Create `plugin/familiar-runtime.ts`:

```typescript
/**
 * Familiar Runtime — eval sandbox for dynamic WebXDC app handlers.
 *
 * Handlers are JavaScript strings authored by Claude. They run in a
 * restricted scope: only ctx (state, sendUpdate, requestLLM, appId,
 * chatId) and standard JS builtins are available. Dangerous globals
 * (fs, net, process, require, import, fetch, Bun) are shadowed.
 *
 * Security model: Claude is the sole author of handler code. The user
 * approves app creation. The handler API is intentionally minimal.
 * This is NOT a general-purpose sandbox for untrusted code.
 */

import { readFileSync, writeFileSync, readdirSync, unlinkSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// ── Types ────────────────────────────────────────────────────────────

export interface SandboxContext {
  state: Record<string, unknown>
  sendUpdate: (payload: unknown) => void
  requestLLM: (prompt: string) => Promise<string>
  appId: string
  chatId: number
}

export interface FamiliarInstance {
  appId: string
  chatId: number
  msgId: number
  title: string
  html: string
  handler: string
  state: Record<string, unknown>
  persistent: boolean
  createdAt: string
  /** Compiled handler function, cached after first eval */
  _fn?: SandboxedHandler
}

type SandboxedHandler = (update: unknown, ctx: SandboxContext) => Promise<{ error?: string }>

// ── Blocked globals ──────────────────────────────────────────────────

const BLOCKED_GLOBALS = [
  'require', 'import', 'fetch', 'process', 'globalThis', 'Bun', 'Deno',
  '__dirname', '__filename', 'fs', 'child_process', 'net', 'http', 'https',
  'os', 'path', 'crypto', 'module', 'exports', 'Buffer', 'setTimeout',
  'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval',
]

// ── Sandbox factory ──────────────────────────────────────────────────

/**
 * Create a sandboxed handler function from a JS source string.
 * The source must define a `handler(update, ctx)` function.
 *
 * Dangerous globals are shadowed with undefined in the closure scope.
 * The handler has access to standard JS builtins (Math, JSON, String,
 * Array, Object, Date, Map, Set, RegExp, etc.) and the ctx API.
 */
export function createSandbox(handlerSource: string): SandboxedHandler {
  const blockedParams = BLOCKED_GLOBALS.join(', ')
  const blockedArgs = BLOCKED_GLOBALS.map(() => 'undefined').join(', ')

  const wrappedSource = `
    return (function(${blockedParams}) {
      ${handlerSource}
      return handler;
    })(${blockedArgs});
  `

  const factory = new Function(wrappedSource)
  const handlerFn = factory()

  return async (update: unknown, ctx: SandboxContext): Promise<{ error?: string }> => {
    try {
      const result = handlerFn(update, ctx)
      if (result && typeof result.then === 'function') {
        await result
      }
      return {}
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  }
}

// ── In-memory registry ───────────────────────────────────────────────

const instances = new Map<string, FamiliarInstance>()
const msgIdIndex = new Map<number, string>()

export function getInstance(appId: string): FamiliarInstance | undefined {
  return instances.get(appId)
}

export function getInstanceByMsgId(msgId: number): FamiliarInstance | undefined {
  const appId = msgIdIndex.get(msgId)
  return appId ? instances.get(appId) : undefined
}

export function listInstances(chatId: number): FamiliarInstance[] {
  return [...instances.values()].filter(i => i.chatId === chatId)
}

export function registerInstance(inst: FamiliarInstance): void {
  instances.set(inst.appId, inst)
  msgIdIndex.set(inst.msgId, inst.appId)
}

export function deleteInstance(appId: string): boolean {
  const inst = instances.get(appId)
  if (!inst) return false
  msgIdIndex.delete(inst.msgId)
  instances.delete(appId)
  return true
}

export function getHandler(inst: FamiliarInstance): SandboxedHandler {
  if (!inst._fn) {
    inst._fn = createSandbox(inst.handler)
  }
  return inst._fn
}

// ── Persistence ──────────────────────────────────────────────────────

function familiarsDir(): string {
  const home = process.env.HOME ?? '/tmp'
  return join(home, '.claude', 'channels', 'deltachat', 'familiars')
}

function instancePath(chatId: number, appId: string): string {
  return join(familiarsDir(), `${chatId}-${appId}.json`)
}

export function persistInstance(inst: FamiliarInstance): void {
  const dir = familiarsDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const { _fn, ...serializable } = inst
  writeFileSync(instancePath(inst.chatId, inst.appId), JSON.stringify(serializable, null, 2))
}

export function deletePersistedInstance(chatId: number, appId: string): void {
  const p = instancePath(chatId, appId)
  try { unlinkSync(p) } catch {}
}

export function loadPersistedInstances(): FamiliarInstance[] {
  const dir = familiarsDir()
  if (!existsSync(dir)) return []
  const files = readdirSync(dir).filter(f => f.endsWith('.json'))
  const loaded: FamiliarInstance[] = []
  for (const file of files) {
    try {
      const data = JSON.parse(readFileSync(join(dir, file), 'utf-8'))
      loaded.push(data as FamiliarInstance)
    } catch {
      // Skip corrupt files
    }
  }
  return loaded
}

// ── YAML import validation ───────────────────────────────────────────

export interface FamiliarYaml {
  name: string
  description?: string
  html: string
  handler: string
  persistent?: boolean
  initialState?: Record<string, unknown>
}

export function parseFamiliarYaml(yamlStr: string): FamiliarYaml {
  const YAML = require('yaml')
  const parsed = YAML.parse(yamlStr)
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid YAML: expected an object')
  }
  if (!parsed.name || typeof parsed.name !== 'string') {
    throw new Error('Missing required field: name')
  }
  if (!parsed.html || typeof parsed.html !== 'string') {
    throw new Error('Missing required field: html')
  }
  if (!parsed.handler || typeof parsed.handler !== 'string') {
    throw new Error('Missing required field: handler')
  }
  try {
    createSandbox(parsed.handler)
  } catch (err) {
    throw new Error(`Invalid handler: ${err instanceof Error ? err.message : String(err)}`)
  }
  return {
    name: parsed.name,
    description: parsed.description,
    html: parsed.html,
    handler: parsed.handler,
    persistent: parsed.persistent ?? false,
    initialState: parsed.initialState ?? {},
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugin && bun test test/familiar-runtime.test.ts`
Expected: All 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add plugin/familiar-runtime.ts plugin/test/familiar-runtime.test.ts
git commit -m "feat(familiar): add runtime core — eval sandbox, registry, persistence (#35)"
```

---

### Task 2: Familiar App Wrapper — WebXDCApp + Tools

**Files:**
- Create: `plugin/apps/familiar-app.ts`
- Create: `plugin/webxdc/familiar-manifest.toml`
- Modify: `plugin/apps.ts`
- Create: `plugin/test/familiar-app.test.ts`

- [ ] **Step 1: Create the manifest**

Create `plugin/webxdc/familiar-manifest.toml`:

```toml
name = "👾 Familiar"
```

- [ ] **Step 2: Write the failing test for dc_familiar_create**

Create `plugin/test/familiar-app.test.ts`:

```typescript
import { describe, test, expect, afterEach } from 'bun:test'
import { familiarApp } from '../apps/familiar-app.ts'
import type { AppContext } from '../webxdc-app.ts'
import * as runtime from '../familiar-runtime.ts'

function mockCtx(overrides: Partial<AppContext> = {}): AppContext {
  return {
    client: {
      sendWebXDC: async () => 100,
      sendWebXDCUpdate: async () => {},
      send: async () => 0,
    } as any,
    mcp: {} as any,
    isAllowed: () => true,
    allowedChats: () => [42],
    logf: () => {},
    safeName: (s: string) => s,
    registerWebXDCMsg: () => {},
    unregisterWebXDCMsg: () => {},
    evictSubagent: async () => {},
    getAvailableMcpServers: () => [],
    ...overrides,
  }
}

describe('familiarApp tools', () => {
  test('tools() returns four tools', () => {
    const tools = familiarApp.tools()
    const names = tools.map(t => t.name)
    expect(names).toContain('dc_familiar_create')
    expect(names).toContain('dc_familiar_update')
    expect(names).toContain('dc_familiar_list')
    expect(names).toContain('dc_familiar_delete')
  })

  test('dc_familiar_create builds app and registers instance', async () => {
    const registered: number[] = []
    const ctx = mockCtx({
      registerWebXDCMsg: (msgId) => { registered.push(msgId) },
    })

    const html = '<!DOCTYPE html><html><head><script src="webxdc.js"></script></head><body>test</body></html>'
    const handler = 'function handler(update, ctx) { ctx.sendUpdate({ echo: update }); }'

    const result = await familiarApp.callTool('dc_familiar_create', {
      chat_id: '42',
      title: 'Test App',
      html,
      handler,
    }, ctx)

    expect(result).toBeTruthy()
    expect(result!.isError).toBeFalsy()
    expect(result!.content[0].text).toContain('Test App')
    expect(registered.length).toBe(1)

    const instances = runtime.listInstances(42)
    expect(instances.length).toBeGreaterThanOrEqual(1)
    const inst = instances.find(i => i.title === 'Test App')
    expect(inst).toBeTruthy()
  })

  test('dc_familiar_create rejects invalid handler', async () => {
    const ctx = mockCtx()
    const result = await familiarApp.callTool('dc_familiar_create', {
      chat_id: '42',
      title: 'Bad App',
      html: '<html></html>',
      handler: 'this is not valid javascript function',
    }, ctx)

    expect(result).toBeTruthy()
    expect(result!.isError).toBe(true)
    expect(result!.content[0].text).toContain('Invalid handler')
  })

  test('dc_familiar_list returns empty for chat with no apps', async () => {
    const ctx = mockCtx()
    const result = await familiarApp.callTool('dc_familiar_list', {
      chat_id: '999',
    }, ctx)

    expect(result).toBeTruthy()
    expect(result!.content[0].text).toContain('No Familiar apps')
  })

  test('callTool returns null for unknown tool', async () => {
    const ctx = mockCtx()
    const result = await familiarApp.callTool('dc_other_tool', {}, ctx)
    expect(result).toBeNull()
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd plugin && bun test test/familiar-app.test.ts`
Expected: FAIL — `familiar-app.ts` does not exist.

- [ ] **Step 4: Implement the Familiar app wrapper**

Create `plugin/apps/familiar-app.ts`:

```typescript
import type { WebXDCApp, ToolDef, ToolResult, AppContext } from '../webxdc-app.js'
import type { WebXDCUpdate } from '../dc-client.js'
import { join } from 'node:path'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { zipSync, strToU8 } from 'fflate'
import { nanoid } from 'nanoid'
import * as runtime from '../familiar-runtime.js'

const MANIFEST_PATH = join(import.meta.dir, '..', 'webxdc', 'familiar-manifest.toml')

function buildFamiliarXDC(html: string, title: string): string {
  const manifest = readFileSync(MANIFEST_PATH, 'utf-8')
    .replace(/^(name\s*=\s*"[^"]+)(")/m, `$1: ${title}$2`)
  const iconPath = join(import.meta.dir, '..', 'webxdc', 'familiar-icon.png')

  const files: Record<string, Uint8Array> = {
    'index.html': strToU8(html),
    'manifest.toml': strToU8(manifest),
  }
  if (existsSync(iconPath)) {
    const icon = readFileSync(iconPath)
    files['icon.png'] = new Uint8Array(icon.buffer, icon.byteOffset, icon.byteLength)
  }

  const dir = mkdtempSync(join(tmpdir(), 'claude-dc-familiar-'))
  const xdcPath = join(dir, 'familiar.xdc')
  writeFileSync(xdcPath, zipSync(files))
  return xdcPath
}

export const familiarApp: WebXDCApp = {
  id: 'familiar',

  instructions: `You can build custom WebXDC apps for users. There are two types:
- Static apps: self-contained HTML sent via dc_send_webxdc. For simple tools, games, and displays.
- Familiar apps: WebXDC apps with a Claude backend via dc_familiar_create. You provide HTML (the UI) and a handler function (server-side JS). The handler receives user interactions and can maintain state, send updates back, or call requestLLM() for AI-powered responses.

When a user asks you to build an app, game, tool, dashboard, or interactive experience, assess whether it needs a server component (Familiar) or is self-contained (static), then build and send it.

Handler API: your handler function receives (update, ctx) where:
- ctx.state: mutable object persisted across updates
- ctx.sendUpdate(payload): push data back to the WebXDC app
- ctx.requestLLM(prompt): async — ask Claude a question and get a text response
- ctx.appId, ctx.chatId: identifiers

The handler runs in a restricted sandbox — no fs, net, fetch, require, or process access. Only pure JS computation + the ctx API.

WebXDC HTML rules: no CDN/external URLs, include <script src="webxdc.js"></script>, use window.webxdc.sendUpdate({payload: {senderAddr: window.webxdc.selfAddr, ...data}}, 'desc') to send data, use window.webxdc.setUpdateListener(fn, 0) to receive data. Updates replay from serial 0 on every open — handlers must be idempotent.`,

  tools(): ToolDef[] {
    return [
      {
        name: 'dc_familiar_create',
        description: 'Create and send a Familiar app — a WebXDC app with a Claude backend. Provide the HTML UI and a JavaScript handler function. The handler receives user interactions via (update, ctx) and can use ctx.state, ctx.sendUpdate(), and ctx.requestLLM().',
        inputSchema: {
          type: 'object' as const,
          properties: {
            chat_id: { type: 'string', description: 'Chat ID to send to' },
            title: { type: 'string', description: 'App title' },
            html: { type: 'string', description: 'Complete HTML source for the WebXDC app' },
            handler: { type: 'string', description: 'JavaScript handler function as a string. Must define a handler(update, ctx) function.' },
            initial_state: { type: 'string', description: 'JSON string for initial ctx.state. Defaults to {}.' },
            persistent: { type: 'boolean', description: 'Whether to persist across dispatcher restarts. Defaults to false.' },
          },
          required: ['chat_id', 'title', 'html', 'handler'],
        },
      },
      {
        name: 'dc_familiar_update',
        description: 'Push a server-initiated update to a running Familiar app.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            chat_id: { type: 'string', description: 'Chat ID (for authorization)' },
            app_id: { type: 'string', description: 'Familiar app instance ID' },
            payload: { type: 'string', description: 'JSON string payload to send to the WebXDC' },
          },
          required: ['chat_id', 'app_id', 'payload'],
        },
      },
      {
        name: 'dc_familiar_list',
        description: 'List active Familiar apps in a chat.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            chat_id: { type: 'string', description: 'Chat ID' },
          },
          required: ['chat_id'],
        },
      },
      {
        name: 'dc_familiar_delete',
        description: 'Remove a Familiar app and its persisted state.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            chat_id: { type: 'string', description: 'Chat ID (for authorization)' },
            app_id: { type: 'string', description: 'Familiar app instance ID' },
          },
          required: ['chat_id', 'app_id'],
        },
      },
    ]
  },

  async callTool(name: string, args: Record<string, unknown>, ctx: AppContext): Promise<ToolResult | null> {
    if (name === 'dc_familiar_create') {
      const chatId = Number(args.chat_id as string)
      const title = ((args.title as string) ?? '').trim()
      const html = ((args.html as string) ?? '').trim()
      const handlerSrc = ((args.handler as string) ?? '').trim()
      const persistent = Boolean(args.persistent)
      let initialState: Record<string, unknown> = {}

      if (!chatId || !title || !html || !handlerSrc) {
        return { content: [{ type: 'text', text: 'dc_familiar_create: chat_id, title, html, and handler are required' }], isError: true }
      }
      if (!ctx.isAllowed(chatId)) {
        return { content: [{ type: 'text', text: `dc_familiar_create: chat ${chatId} is not on the allowlist` }], isError: true }
      }

      if (args.initial_state) {
        try {
          initialState = JSON.parse(args.initial_state as string)
        } catch {
          return { content: [{ type: 'text', text: 'dc_familiar_create: initial_state is not valid JSON' }], isError: true }
        }
      }

      try {
        runtime.createSandbox(handlerSrc)
      } catch (err) {
        return { content: [{ type: 'text', text: `dc_familiar_create: Invalid handler: ${err instanceof Error ? err.message : String(err)}` }], isError: true }
      }

      const xdcPath = buildFamiliarXDC(html, title)
      const msgId = await ctx.client.sendWebXDC(chatId, xdcPath)
      try { unlinkSync(xdcPath) } catch {}

      const appId = nanoid(8)
      const inst: runtime.FamiliarInstance = {
        appId,
        chatId,
        msgId,
        title,
        html,
        handler: handlerSrc,
        state: { ...initialState },
        persistent,
        createdAt: new Date().toISOString(),
      }
      runtime.registerInstance(inst)
      ctx.registerWebXDCMsg(msgId, this, chatId)

      if (persistent) {
        runtime.persistInstance(inst)
      }

      ctx.logf('familiar: created app "%s" (id=%s) in chat %d (persistent=%s)', title, appId, chatId, persistent)
      return { content: [{ type: 'text', text: `Created Familiar app "${title}" (id: ${appId}) in chat ${chatId}.` }] }
    }

    if (name === 'dc_familiar_update') {
      const chatId = Number(args.chat_id as string)
      const appId = (args.app_id as string ?? '').trim()
      const payloadStr = (args.payload as string ?? '').trim()

      if (!chatId || !appId || !payloadStr) {
        return { content: [{ type: 'text', text: 'dc_familiar_update: chat_id, app_id, and payload are required' }], isError: true }
      }
      if (!ctx.isAllowed(chatId)) {
        return { content: [{ type: 'text', text: `dc_familiar_update: chat ${chatId} is not on the allowlist` }], isError: true }
      }

      const inst = runtime.getInstance(appId)
      if (!inst || inst.chatId !== chatId) {
        return { content: [{ type: 'text', text: `dc_familiar_update: app "${appId}" not found in chat ${chatId}` }], isError: true }
      }

      let payload: unknown
      try {
        payload = JSON.parse(payloadStr)
      } catch {
        return { content: [{ type: 'text', text: 'dc_familiar_update: payload is not valid JSON' }], isError: true }
      }

      const update = JSON.stringify({ payload })
      await ctx.client.sendWebXDCUpdate(inst.msgId, update)

      return { content: [{ type: 'text', text: `Update sent to "${inst.title}".` }] }
    }

    if (name === 'dc_familiar_list') {
      const chatId = Number(args.chat_id as string)
      if (!chatId) {
        return { content: [{ type: 'text', text: 'dc_familiar_list: chat_id is required' }], isError: true }
      }

      const instances = runtime.listInstances(chatId)
      if (instances.length === 0) {
        return { content: [{ type: 'text', text: `No Familiar apps in chat ${chatId}.` }] }
      }

      const lines = instances.map(i =>
        `- ${i.title} (id: ${i.appId}, persistent: ${i.persistent}, created: ${i.createdAt})`
      )
      return { content: [{ type: 'text', text: lines.join('\n') }] }
    }

    if (name === 'dc_familiar_delete') {
      const chatId = Number(args.chat_id as string)
      const appId = (args.app_id as string ?? '').trim()

      if (!chatId || !appId) {
        return { content: [{ type: 'text', text: 'dc_familiar_delete: chat_id and app_id are required' }], isError: true }
      }
      if (!ctx.isAllowed(chatId)) {
        return { content: [{ type: 'text', text: `dc_familiar_delete: chat ${chatId} is not on the allowlist` }], isError: true }
      }

      const inst = runtime.getInstance(appId)
      if (!inst || inst.chatId !== chatId) {
        return { content: [{ type: 'text', text: `dc_familiar_delete: app "${appId}" not found in chat ${chatId}` }], isError: true }
      }

      ctx.unregisterWebXDCMsg(inst.msgId)
      runtime.deleteInstance(appId)
      if (inst.persistent) {
        runtime.deletePersistedInstance(chatId, appId)
      }

      ctx.logf('familiar: deleted app "%s" (id=%s) from chat %d', inst.title, appId, chatId)
      return { content: [{ type: 'text', text: `Deleted Familiar app "${inst.title}".` }] }
    }

    return null
  },

  async onWebXDCUpdate(msgId: number, updates: WebXDCUpdate[], ctx: AppContext): Promise<void> {
    const inst = runtime.getInstanceByMsgId(msgId)
    if (!inst) return

    const handler = runtime.getHandler(inst)

    for (const u of updates) {
      const payload = u.payload as Record<string, unknown> | null
      if (!payload) continue

      const sandboxCtx: runtime.SandboxContext = {
        state: inst.state,
        sendUpdate: (outPayload) => {
          const update = JSON.stringify({ payload: outPayload })
          ctx.client.sendWebXDCUpdate(inst.msgId, update).catch(err => {
            ctx.logf('familiar: sendUpdate failed for app %s: %v', inst.appId, err)
          })
        },
        requestLLM: async (_prompt) => {
          // Placeholder — wired in Task 4
          return '[requestLLM not yet wired]'
        },
        appId: inst.appId,
        chatId: inst.chatId,
      }

      const result = await handler(payload, sandboxCtx)
      if (result.error) {
        ctx.logf('familiar: handler error for app %s: %s', inst.appId, result.error)
      }

      if (inst.persistent) {
        runtime.persistInstance(inst)
      }
    }
  },

  start(ctx: AppContext): void {
    const persisted = runtime.loadPersistedInstances()
    for (const inst of persisted) {
      runtime.registerInstance(inst)
      ctx.registerWebXDCMsg(inst.msgId, this, inst.chatId)
      ctx.logf('familiar: reloaded persistent app "%s" (id=%s) for chat %d', inst.title, inst.appId, inst.chatId)
    }
  },
}
```

- [ ] **Step 5: Register in apps.ts**

Modify `plugin/apps.ts` — add import and array entry:

```typescript
import type { WebXDCApp } from './webxdc-app.js'
import { fileReviewerApp } from './apps/file-reviewer-app.js'
import { permissionsApp } from './apps/permissions-app.js'
import { agentSetupApp } from './apps/agent-setup-app.js'
import { slideViewerApp } from './apps/slide-viewer-app.js'
import { familiarApp } from './apps/familiar-app.js'

export const apps: WebXDCApp[] = [
  fileReviewerApp,
  permissionsApp,
  agentSetupApp,
  slideViewerApp,
  familiarApp,
]
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd plugin && bun test test/familiar-app.test.ts`
Expected: All tests PASS.

- [ ] **Step 7: Run full test suite**

Run: `cd plugin && bun test`
Expected: All existing tests still pass.

- [ ] **Step 8: Commit**

```bash
git add plugin/apps/familiar-app.ts plugin/webxdc/familiar-manifest.toml plugin/apps.ts plugin/test/familiar-app.test.ts
git commit -m "feat(familiar): add WebXDCApp wrapper with four tools (#35)"
```

---

### Task 3: .familiar.yaml Import Flow

**Files:**
- Modify: `plugin/server.ts` (add import interceptor)
- Modify: `plugin/test/familiar-runtime.test.ts` (add YAML parse tests)

- [ ] **Step 1: Write failing tests for YAML parsing**

Append to `plugin/test/familiar-runtime.test.ts`:

```typescript
import { parseFamiliarYaml } from '../familiar-runtime.ts'

describe('parseFamiliarYaml', () => {
  test('parses valid familiar YAML', () => {
    const yaml = `
name: Test App
description: A test
html: "<html><body>hello</body></html>"
handler: |
  function handler(update, ctx) {
    ctx.sendUpdate({ echo: update });
  }
persistent: true
initialState:
  count: 0
`
    const result = parseFamiliarYaml(yaml)
    expect(result.name).toBe('Test App')
    expect(result.description).toBe('A test')
    expect(result.html).toContain('<html>')
    expect(result.handler).toContain('function handler')
    expect(result.persistent).toBe(true)
    expect(result.initialState).toEqual({ count: 0 })
  })

  test('rejects YAML without name', () => {
    const yaml = `
html: "<html></html>"
handler: "function handler(u, c) {}"
`
    expect(() => parseFamiliarYaml(yaml)).toThrow('Missing required field: name')
  })

  test('rejects YAML without html', () => {
    const yaml = `
name: Bad App
handler: "function handler(u, c) {}"
`
    expect(() => parseFamiliarYaml(yaml)).toThrow('Missing required field: html')
  })

  test('rejects YAML with invalid handler', () => {
    const yaml = `
name: Bad Handler
html: "<html></html>"
handler: "this is not javascript"
`
    expect(() => parseFamiliarYaml(yaml)).toThrow('Invalid handler')
  })

  test('defaults persistent to false and initialState to {}', () => {
    const yaml = `
name: Minimal
html: "<html></html>"
handler: "function handler(u, c) {}"
`
    const result = parseFamiliarYaml(yaml)
    expect(result.persistent).toBe(false)
    expect(result.initialState).toEqual({})
  })
})
```

- [ ] **Step 2: Run tests to verify YAML tests pass**

Run: `cd plugin && bun test test/familiar-runtime.test.ts`
Expected: All tests PASS (sandbox + YAML parsing already implemented in Task 1).

- [ ] **Step 3: Add .familiar.yaml import interceptor to server.ts**

In `plugin/server.ts`, add `import * as familiarRuntime from './familiar-runtime.js'` at the top with the other imports.

Find the `tryImportAgentAttachment` function (around line 1456). Add this function right before it:

```typescript
  const tryImportFamiliarAttachment = async (msg: Message): Promise<boolean> => {
    if (!msg.file || !msg.fileName) return false
    const lower = msg.fileName.toLowerCase()
    if (!lower.endsWith('.familiar.yaml') && !lower.endsWith('.familiar.yml')) return false

    const chatId = msg.chatId
    const MAX_IMPORT_BYTES = 512 * 1024

    try {
      if (msg.fileBytes && msg.fileBytes > MAX_IMPORT_BYTES) {
        await client.send(chatId, '⚠️ Familiar import failed: file too large (max 512 KB).')
        return true
      }

      const { readFileSync } = await import('node:fs')
      const yamlStr = readFileSync(msg.file, 'utf-8')
      const parsed = familiarRuntime.parseFamiliarYaml(yamlStr)

      const familiarAppInstance = apps.find(a => a.id === 'familiar')
      if (!familiarAppInstance) {
        await client.send(chatId, '⚠️ Familiar runtime not available.')
        return true
      }

      const result = await familiarAppInstance.callTool('dc_familiar_create', {
        chat_id: String(chatId),
        title: parsed.name,
        html: parsed.html,
        handler: parsed.handler,
        initial_state: JSON.stringify(parsed.initialState ?? {}),
        persistent: parsed.persistent ?? false,
      }, ctx)

      if (result?.isError) {
        await client.send(chatId, `⚠️ Familiar import failed: ${result.content[0].text}`)
        return true
      }

      await client.send(chatId, `✅ Imported Familiar app "${parsed.name}". ${result?.content[0].text ?? ''}`)
      logf('familiar-import: "%s" imported from attachment in chat %d', parsed.name, chatId)
      return true
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const short = message.length > 200 ? message.slice(0, 200) + '...' : message
      await client.send(chatId, `⚠️ Couldn't import Familiar app from "${msg.fileName}": ${short}`)
      logf('familiar-import: failed for chat %d file=%s: %v', chatId, msg.fileName, err)
      return false
    }
  }
```

Then in `runSubagentTurn` (around line 1498), add the familiar check before the agent import check:

```typescript
  const runSubagentTurn = async (msg: Message): Promise<void> => {
    if (await tryImportFamiliarAttachment(msg)) return
    if (await tryImportAgentAttachment(msg)) return
    // ... rest unchanged
```

- [ ] **Step 4: Run full test suite**

Run: `cd plugin && bun test`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add plugin/server.ts plugin/test/familiar-runtime.test.ts
git commit -m "feat(familiar): add .familiar.yaml import flow (#35)"
```

---

### Task 4: Wire requestLLM to Dispatcher

**Files:**
- Modify: `plugin/webxdc-app.ts` (add dispatchAndCollect to AppContext)
- Modify: `plugin/apps/familiar-app.ts` (replace requestLLM placeholder)
- Modify: `plugin/server.ts` (implement dispatchAndCollect)

- [ ] **Step 1: Add dispatchAndCollect to AppContext**

In `plugin/webxdc-app.ts`, add to the `AppContext` interface:

```typescript
  /** Dispatch a synthetic user message to a chat's subagent and return the response text. */
  dispatchAndCollect?: (chatId: number, text: string) => Promise<string>
```

- [ ] **Step 2: Implement dispatchAndCollect in server.ts**

In `plugin/server.ts`, find where the `ctx` AppContext object is constructed. Add the `dispatchAndCollect` method. This uses the same dispatch path as the scheduler — check the `subagentCache` API to determine the exact method signature.

Look at how the scheduler calls `this.dispatch(chatId, text)` — this is passed as a constructor arg. In server.ts, find where the Scheduler is constructed and trace back to what `dispatch` is. Then expose the same mechanism on ctx.

The implementation will look something like:

```typescript
    dispatchAndCollect: async (chatId: number, text: string) => {
      const result = await subagentCache.dispatch(chatId, text)
      return typeof result === 'string' ? result : ''
    },
```

If `subagentCache.dispatch` doesn't return the response text, you'll need to check its signature. It may return `void` or a result object. In that case, the requestLLM feature should be deferred to a follow-up task and the placeholder left in place with a clear comment.

- [ ] **Step 3: Update familiar-app.ts to use dispatchAndCollect**

In the `onWebXDCUpdate` handler in `plugin/apps/familiar-app.ts`, replace the requestLLM placeholder:

```typescript
        requestLLM: async (prompt) => {
          if (!ctx.dispatchAndCollect) return '[requestLLM not available]'
          const text = `[familiar app="${inst.title}" id=${inst.appId}]\nThe Familiar app handler is requesting an LLM response. Respond with just the answer text, no tool calls.\n\n${prompt}`
          return ctx.dispatchAndCollect(inst.chatId, text)
        },
```

- [ ] **Step 4: Run full test suite**

Run: `cd plugin && bun test`
Expected: All tests pass. (Tests mock AppContext without dispatchAndCollect, which is optional.)

- [ ] **Step 5: Commit**

```bash
git add plugin/webxdc-app.ts plugin/apps/familiar-app.ts plugin/server.ts
git commit -m "feat(familiar): wire requestLLM to dispatcher dispatch (#35)"
```

---

### Task 5: WebXDC Builder Skill

**Files:**
- Create: `plugin/skills/webxdc-builder/SKILL.md`

- [ ] **Step 1: Create the skill directory**

```bash
mkdir -p plugin/skills/webxdc-builder
```

- [ ] **Step 2: Write the skill file**

Create `plugin/skills/webxdc-builder/SKILL.md`:

````markdown
---
name: webxdc-builder
description: Build WebXDC apps for Delta Chat — static HTML apps or Familiar apps with a Claude backend. Use when a user asks to build an app, game, tool, dashboard, or interactive experience in their chat.
user-invocable: false
allowed-tools:
  - mcp__dc__dc_send_webxdc
  - mcp__dc__dc_familiar_create
  - mcp__dc__dc_familiar_update
  - mcp__dc__dc_familiar_list
  - mcp__dc__dc_familiar_delete
  - mcp__dc__reply
---

# WebXDC App Builder

Build custom WebXDC apps on demand for Delta Chat users.

## Decision Tree

1. **Does the app need a server component?** (web data, AI responses, persistent game state managed by Claude, scheduled updates)
   - **Yes** → Familiar app via `dc_familiar_create`
   - **No** → Static app via `dc_send_webxdc`

2. **Single-user or multi-user?**
   - Multi-user apps must use `senderAddr` to distinguish players/users
   - In group chats, all members see all WebXDC updates

3. **Ephemeral or persistent?**
   - Persistent Familiar apps survive dispatcher restarts (set `persistent: true`)
   - Static apps are always ephemeral

---

## WebXDC HTML Rules (MANDATORY)

- **No external resources**: no CDN, no `fetch()`, no external URLs
- **Include**: `<script src="webxdc.js"></script>` (injected by messenger)
- **Receive data**: `window.webxdc.setUpdateListener(function(update) { ... }, 0)`
- **Send data**: `window.webxdc.sendUpdate({payload: {senderAddr: window.webxdc.selfAddr, ...data}}, 'desc')`
- **REQUIRED**: Every payload MUST include `senderAddr: window.webxdc.selfAddr`
- **Replay safety**: Updates replay from serial 0 on every open — reconstruct state from full replay
- **XSS prevention**: Use `textContent` not `innerHTML` for user data
- **All assets inline**: CSS in `<style>`, JS in `<script>`, images as data URIs

---

## Static App Flow

1. Generate complete HTML following rules above
2. Send via `dc_send_webxdc`

## Familiar App Flow

1. Generate HTML (client UI)
2. Write handler function:

```javascript
function handler(update, ctx) {
  // update: payload from WebXDC sendUpdate
  // ctx.state: mutable, persisted across updates
  // ctx.sendUpdate(payload): push data back to app
  // ctx.requestLLM(prompt): async, ask Claude
  // ctx.appId, ctx.chatId: identifiers
}
```

3. Send via `dc_familiar_create` with html, handler, title

---

## Handler Patterns

### Pure Deterministic

```javascript
function handler(update, ctx) {
  if (update.type === 'guess') {
    var correct = update.value === ctx.state.answer;
    ctx.state.score = (ctx.state.score || 0) + (correct ? 1 : 0);
    ctx.sendUpdate({ type: 'result', correct: correct, score: ctx.state.score });
  }
}
```

### Pure LLM

```javascript
function handler(update, ctx) {
  if (update.type === 'question') {
    var answer = ctx.requestLLM('User asked: ' + update.text);
    ctx.sendUpdate({ type: 'answer', text: answer });
  }
}
```

### Hybrid

```javascript
function handler(update, ctx) {
  if (update.type === 'answer') {
    var correct = update.value === ctx.state.currentAnswer;
    ctx.state.score = (ctx.state.score || 0) + (correct ? 10 : 0);
    ctx.sendUpdate({ type: 'score', score: ctx.state.score });
    var commentary = ctx.requestLLM('Player ' + (correct ? 'correct' : 'wrong') + '. Score: ' + ctx.state.score);
    ctx.sendUpdate({ type: 'commentary', text: commentary });
  }
}
```

### Multi-user

```javascript
function handler(update, ctx) {
  if (update.type === 'join') {
    ctx.state.players = ctx.state.players || {};
    ctx.state.players[update.senderAddr] = { name: update.name, score: 0 };
    ctx.sendUpdate({ type: 'players', players: ctx.state.players });
  }
}
```
````

- [ ] **Step 3: Commit**

```bash
git add plugin/skills/webxdc-builder/SKILL.md
git commit -m "feat(familiar): add webxdc-builder skill (#35)"
```

---

### Task 6: CLAUDE.md + Icon + Final Verification

**Files:**
- Modify: `CLAUDE.md`
- Create: `plugin/webxdc/familiar-icon.png`

- [ ] **Step 1: Add Familiar runtime documentation to CLAUDE.md**

Add a new section after the "Per-agent tool access" paragraph:

```markdown
## Familiar Runtime (v1.0+)

The **Familiar runtime** lets subagents build custom WebXDC apps on the fly
with Claude acting as a live backend. Two app types:

- **Static apps** — self-contained HTML, sent via `dc_send_webxdc`. No
  server component.
- **Familiar apps** — WebXDC apps with a Claude backend, created via
  `dc_familiar_create`. The subagent provides HTML (the client UI) and a
  JavaScript handler function (server-side logic). The handler runs in an
  eval sandbox with access to `ctx.state`, `ctx.sendUpdate()`, and
  `ctx.requestLLM()` — no fs/net/process access.

Familiar apps can be ephemeral (lost on restart) or persistent (state +
handler saved to `~/.claude/channels/deltachat/familiars/`). Persistent
apps are reloaded on dispatcher startup.

**Import:** Send a `.familiar.yaml` file as an attachment in any paired
chat. The dispatcher intercepts it, validates the YAML (required fields:
`name`, `html`, `handler`), and creates the Familiar app. Invalid YAML is
rejected with an error.

**Tools:** `dc_familiar_create`, `dc_familiar_update`, `dc_familiar_list`,
`dc_familiar_delete`.
```

- [ ] **Step 2: Generate a placeholder icon**

```bash
python3 -c "
import struct, zlib
def png(w,h,r,g,b):
    raw=b''
    for y in range(h): raw+=b'\x00'+bytes([r,g,b])*w
    d=zlib.compress(raw)
    def chunk(t,data): return struct.pack('>I',len(data))+t+data+struct.pack('>I',zlib.crc32(t+data)&0xffffffff)
    return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',w,h,8,2,0,0,0))+chunk(b'IDAT',d)+chunk(b'IEND',b'')
open('plugin/webxdc/familiar-icon.png','wb').write(png(256,256,124,58,237))
"
```

- [ ] **Step 3: Run full test suite**

Run: `cd plugin && bun test`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md plugin/webxdc/familiar-icon.png
git commit -m "docs: document Familiar runtime in CLAUDE.md, add icon (#35)"
```

- [ ] **Step 5: Manual smoke test (requires dispatcher bounce)**

1. Restart the dispatcher
2. In a paired chat, ask: "Build me a simple counter app where I tap a button and it counts up"
3. Verify the agent uses `dc_familiar_create`
4. Tap the WebXDC card, verify it opens
5. Tap the counter button, verify the count updates (handler processes the update)
6. Send a `.familiar.yaml` file as an attachment, verify it imports and creates the app
