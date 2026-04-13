/**
 * Familiar WebXDC app wrapper.
 *
 * Integrates the familiar runtime (eval sandbox, registry, persistence)
 * with the dc-claude-channel plugin system. Exposes four tools:
 * dc_familiar_create, dc_familiar_update, dc_familiar_list, dc_familiar_delete.
 */

import type { WebXDCApp, ToolDef, ToolResult, AppContext } from '../webxdc-app.js'
import type { WebXDCUpdate } from '../dc-client.js'
import {
  createSandbox,
  registerInstance,
  getInstance,
  getInstanceByMsgId,
  listInstances,
  deleteInstance,
  getHandler,
  persistInstance,
  deletePersistedInstance,
  loadPersistedInstances,
  type FamiliarInstance,
  type SandboxContext,
} from '../familiar-runtime.js'
import { readFileSync, writeFileSync, mkdtempSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { zipSync, strToU8 } from 'fflate'

// ---------------------------------------------------------------------------
// Manifest + icon (read once at import time)
// ---------------------------------------------------------------------------

const MANIFEST_TOML = readFileSync(join(import.meta.dir, '..', 'webxdc', 'familiar-manifest.toml'))
let ICON_PNG: Uint8Array | null = null
try {
  const raw = readFileSync(join(import.meta.dir, '..', 'webxdc', 'familiar-icon.png'))
  ICON_PNG = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
} catch {
  // No icon — that's fine, XDC works without one
}

// ---------------------------------------------------------------------------
// XDC builder (inline zip via fflate — HTML is a string, not a file)
// ---------------------------------------------------------------------------

function buildFamiliarXDC(html: string, title: string): string {
  const files: Record<string, Uint8Array> = {
    'index.html': strToU8(html),
    'manifest.toml': MANIFEST_TOML instanceof Uint8Array
      ? MANIFEST_TOML
      : new Uint8Array(MANIFEST_TOML.buffer, MANIFEST_TOML.byteOffset, MANIFEST_TOML.byteLength),
  }
  if (ICON_PNG) files['icon.png'] = ICON_PNG

  const zipped = zipSync(files)
  const dir = mkdtempSync(join(tmpdir(), 'claude-dc-familiar-'))
  const safe = title.toLowerCase().replace(/[^\x20-\x7e]+/g, '').trim().replace(/\s+/g, '-') || 'familiar'
  const xdcPath = join(dir, `${safe}.xdc`)
  writeFileSync(xdcPath, zipped)
  return xdcPath
}

// ---------------------------------------------------------------------------
// App ID generation
// ---------------------------------------------------------------------------

function generateAppId(): string {
  return crypto.randomUUID().slice(0, 8)
}

// ---------------------------------------------------------------------------
// WebXDCApp implementation
// ---------------------------------------------------------------------------

export const familiarApp: WebXDCApp = {
  id: 'familiar',

  instructions: [
    'You have two ways to send interactive apps to Delta Chat:',
    '',
    '1. **Static WebXDC** (dc_send_webxdc): Send a self-contained HTML file as a .xdc. Good for one-shot displays with no server-side logic.',
    '',
    '2. **Familiar apps** (dc_familiar_create/update/list/delete): Create interactive apps with a server-side handler that processes user actions. The handler is a JS string that runs in a sandbox with access to `ctx.state` (persistent state object), `ctx.sendUpdate(payload)` (push data to the app), and `ctx.requestLLM(prompt)` (ask the LLM for text). The HTML must include `<script src="webxdc.js"></script>`, use `window.webxdc.sendUpdate({payload: {senderAddr: window.webxdc.selfAddr, ...data}}, "")` to send actions, and `window.webxdc.setUpdateListener(fn, 0)` to receive updates. No CDN imports or fetch() allowed. Every sendUpdate payload MUST include `senderAddr: window.webxdc.selfAddr`. The handler receives `(update, ctx)` where update is the user\'s payload.',
    '',
    'Use Familiar apps when the user needs interactive server-side logic (counters, polls, quizzes, stateful workflows). Use static WebXDC for simple one-shot content.',
  ].join('\n'),

  tools(): ToolDef[] {
    return [
      {
        name: 'dc_familiar_create',
        description: 'Create and send a Familiar interactive app to a Delta Chat chat. The handler is a JS string that runs server-side in a sandbox when the user interacts with the app.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            chat_id: { type: 'string', description: 'Chat ID to send to' },
            title: { type: 'string', description: 'App title' },
            html: { type: 'string', description: 'Full HTML for the app. Must include <script src="webxdc.js"></script>. All sendUpdate payloads must include senderAddr: window.webxdc.selfAddr.' },
            handler: { type: 'string', description: 'JS handler source. Receives (update, ctx). ctx has: state (object), sendUpdate(payload), requestLLM(prompt), appId, chatId. Dangerous globals (fs, process, fetch, Bun, require, etc.) are undefined.' },
            initial_state: { type: 'object', description: 'Initial state object (default: {})' },
            persistent: { type: 'boolean', description: 'Persist state across restarts (default: false)' },
          },
          required: ['chat_id', 'title', 'html', 'handler'],
        },
      },
      {
        name: 'dc_familiar_update',
        description: 'Send a payload update to an existing Familiar app instance.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            chat_id: { type: 'string', description: 'Chat ID' },
            app_id: { type: 'string', description: 'App ID returned by dc_familiar_create' },
            payload: { type: 'object', description: 'Payload to send to the app' },
          },
          required: ['chat_id', 'app_id', 'payload'],
        },
      },
      {
        name: 'dc_familiar_list',
        description: 'List all Familiar app instances in a chat.',
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
        description: 'Delete a Familiar app instance (removes from registry and disk).',
        inputSchema: {
          type: 'object' as const,
          properties: {
            chat_id: { type: 'string', description: 'Chat ID' },
            app_id: { type: 'string', description: 'App ID to delete' },
          },
          required: ['chat_id', 'app_id'],
        },
      },
    ]
  },

  async callTool(name: string, args: Record<string, unknown>, ctx: AppContext): Promise<ToolResult | null> {
    switch (name) {
      case 'dc_familiar_create': return handleCreate(args, ctx, this)
      case 'dc_familiar_update': return handleUpdate(args, ctx)
      case 'dc_familiar_list': return handleList(args, ctx)
      case 'dc_familiar_delete': return handleDelete(args, ctx)
      default: return null
    }
  },

  async onWebXDCUpdate(msgId: number, updates: WebXDCUpdate[], ctx: AppContext): Promise<void> {
    const inst = getInstanceByMsgId(msgId)
    if (!inst) return

    const handler = getHandler(inst.appId)
    if (!handler) return

    for (const u of updates) {
      const payload = u.payload as Record<string, unknown> | null
      if (!payload) continue

      // Collect sendUpdate payloads during handler execution, then flush
      // them sequentially afterward to guarantee delivery order.
      const pendingUpdates: unknown[] = []

      const sandboxCtx: SandboxContext = {
        state: inst.state,
        sendUpdate: (outPayload: unknown) => {
          pendingUpdates.push(outPayload)
        },
        requestLLM: async (prompt: string) => {
          if (!ctx.dispatchAndCollect) return '[requestLLM not available]'
          const text = `[familiar app="${inst.title}" id=${inst.appId}]\nThe Familiar app handler is requesting an LLM response. Respond with just the answer text, no tool calls.\n\n${prompt}`
          return ctx.dispatchAndCollect(inst.chatId, text)
        },
        appId: inst.appId,
        chatId: inst.chatId,
      }

      const result = await handler(payload, sandboxCtx)
      if (result.error) {
        ctx.logf('familiar: handler error for app %s: %s', inst.appId, result.error)
      }

      // Flush collected updates sequentially to preserve ordering
      for (const outPayload of pendingUpdates) {
        try {
          await ctx.client.sendWebXDCUpdate(inst.msgId, JSON.stringify({ payload: outPayload }))
        } catch (err: unknown) {
          ctx.logf('familiar: sendUpdate error for app %s: %s', inst.appId, err)
        }
      }

      // Persist state after each handler invocation for persistent apps
      if (inst.persistent) {
        try {
          persistInstance(inst)
        } catch (err: unknown) {
          ctx.logf('familiar: persist error for app %s: %s', inst.appId, err)
        }
      }
    }
  },

  start(ctx: AppContext): void {
    const persisted = loadPersistedInstances()
    for (const inst of persisted) {
      registerInstance(inst)
      ctx.registerWebXDCMsg(inst.msgId, this, inst.chatId)
      ctx.logf('familiar: restored persistent app %s in chat %d', inst.appId, inst.chatId)
    }
  },
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

async function handleCreate(
  args: Record<string, unknown>,
  ctx: AppContext,
  app: WebXDCApp,
): Promise<ToolResult> {
  const chatId = Number(args.chat_id as string)
  const title = ((args.title as string) ?? '').trim()
  const html = ((args.html as string) ?? '').trim()
  const handlerSource = ((args.handler as string) ?? '').trim()
  const initialState = (args.initial_state as Record<string, unknown>) ?? {}
  const persistent = (args.persistent as boolean) ?? false

  if (!chatId || Number.isNaN(chatId)) {
    return { content: [{ type: 'text', text: 'dc_familiar_create: chat_id is required' }], isError: true }
  }
  if (!ctx.isAllowed(chatId)) {
    return { content: [{ type: 'text', text: `dc_familiar_create: chat ${chatId} is not on the allowlist` }], isError: true }
  }
  if (!title) {
    return { content: [{ type: 'text', text: 'dc_familiar_create: title is required' }], isError: true }
  }
  if (!html) {
    return { content: [{ type: 'text', text: 'dc_familiar_create: html is required' }], isError: true }
  }
  if (!handlerSource) {
    return { content: [{ type: 'text', text: 'dc_familiar_create: handler is required' }], isError: true }
  }

  // Validate handler compiles
  try {
    createSandbox(handlerSource)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { content: [{ type: 'text', text: `dc_familiar_create: handler compile error: ${msg}` }], isError: true }
  }

  // Build and send XDC
  const xdcPath = buildFamiliarXDC(html, title)
  let msgId: number
  try {
    msgId = await ctx.client.sendWebXDC(chatId, xdcPath)
  } finally {
    try { unlinkSync(xdcPath) } catch {}
  }

  // Register instance
  const appId = generateAppId()
  const inst: FamiliarInstance = {
    appId,
    chatId,
    msgId,
    title,
    html,
    handler: handlerSource,
    state: { ...initialState },
    persistent,
    createdAt: new Date().toISOString(),
  }
  registerInstance(inst)
  ctx.registerWebXDCMsg(msgId, app, chatId)

  // Persist if requested
  if (persistent) {
    persistInstance(inst)
  }

  return {
    content: [{ type: 'text', text: `Created familiar "${title}" (app_id: ${appId}) in chat ${chatId}.` }],
  }
}

async function handleUpdate(
  args: Record<string, unknown>,
  ctx: AppContext,
): Promise<ToolResult> {
  const chatId = Number(args.chat_id as string)
  const appId = ((args.app_id as string) ?? '').trim()
  const payload = args.payload

  if (!chatId || Number.isNaN(chatId)) {
    return { content: [{ type: 'text', text: 'dc_familiar_update: chat_id is required' }], isError: true }
  }
  if (!ctx.isAllowed(chatId)) {
    return { content: [{ type: 'text', text: `dc_familiar_update: chat ${chatId} is not on the allowlist` }], isError: true }
  }
  if (!appId) {
    return { content: [{ type: 'text', text: 'dc_familiar_update: app_id is required' }], isError: true }
  }
  if (payload === undefined || payload === null) {
    return { content: [{ type: 'text', text: 'dc_familiar_update: payload is required' }], isError: true }
  }

  const inst = getInstance(appId)
  if (!inst) {
    return { content: [{ type: 'text', text: `dc_familiar_update: app ${appId} not found` }], isError: true }
  }
  if (inst.chatId !== chatId) {
    return { content: [{ type: 'text', text: `dc_familiar_update: app ${appId} is not in chat ${chatId}` }], isError: true }
  }

  const update = JSON.stringify({ payload })
  await ctx.client.sendWebXDCUpdate(inst.msgId, update)

  return { content: [{ type: 'text', text: `Update sent to "${inst.title}" (${appId}).` }] }
}

async function handleList(
  args: Record<string, unknown>,
  ctx: AppContext,
): Promise<ToolResult> {
  const chatId = Number(args.chat_id as string)
  if (!chatId || Number.isNaN(chatId)) {
    return { content: [{ type: 'text', text: 'dc_familiar_list: chat_id is required' }], isError: true }
  }
  if (!ctx.isAllowed(chatId)) {
    return { content: [{ type: 'text', text: `dc_familiar_list: chat ${chatId} is not on the allowlist` }], isError: true }
  }

  const instances = listInstances(chatId)
  if (instances.length === 0) {
    return { content: [{ type: 'text', text: `No familiar apps in chat ${chatId}.` }] }
  }

  const lines = instances.map(
    (i) => `- ${i.title} (app_id: ${i.appId}, persistent: ${i.persistent}, created: ${i.createdAt})`,
  )
  return { content: [{ type: 'text', text: `Familiar apps in chat ${chatId}:\n${lines.join('\n')}` }] }
}

async function handleDelete(
  args: Record<string, unknown>,
  ctx: AppContext,
): Promise<ToolResult> {
  const chatId = Number(args.chat_id as string)
  const appId = ((args.app_id as string) ?? '').trim()

  if (!chatId || Number.isNaN(chatId)) {
    return { content: [{ type: 'text', text: 'dc_familiar_delete: chat_id is required' }], isError: true }
  }
  if (!ctx.isAllowed(chatId)) {
    return { content: [{ type: 'text', text: `dc_familiar_delete: chat ${chatId} is not on the allowlist` }], isError: true }
  }
  if (!appId) {
    return { content: [{ type: 'text', text: 'dc_familiar_delete: app_id is required' }], isError: true }
  }

  const inst = getInstance(appId)
  if (!inst) {
    return { content: [{ type: 'text', text: `dc_familiar_delete: app ${appId} not found` }], isError: true }
  }
  if (inst.chatId !== chatId) {
    return { content: [{ type: 'text', text: `dc_familiar_delete: app ${appId} is not in chat ${chatId}` }], isError: true }
  }

  // Unregister WebXDC msg
  ctx.unregisterWebXDCMsg(inst.msgId)

  // Delete from registry and disk
  deleteInstance(appId)
  if (inst.persistent) {
    deletePersistedInstance(appId)
  }

  return { content: [{ type: 'text', text: `Deleted familiar "${inst.title}" (${appId}) from chat ${chatId}.` }] }
}
