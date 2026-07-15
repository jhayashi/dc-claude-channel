/**
 * Create-agent WebXDC app — standalone bespoke card for the agent-creation
 * flow (catalog wall → coach interview OR direct form-create). Split out of
 * the agent-setup monolith and gated by the §6 ControlAuthDeps helper.
 *
 * The coach interview itself stays a *chat conversation*: the card's
 * `build-agent` action calls the existing handleBuildAgent (exported from
 * agent-setup-app.ts), which starts the chat-coach in coachSessions and
 * the dispatcher's advanceCoach routing carries it from there. This app
 * only opens the card, ships the catalog init, and relays the two
 * card-driven actions (build-agent / create) into the shared handlers.
 *
 * Authorization note (§6): webXDC senderAddr is app-relayed and spoofable
 * (verified, dc-core 2.53). State-changing handlers MUST gate on
 * isControlCommandAuthorized rather than anything the card payload says.
 */

import type { WebXDCApp, ToolDef, ToolResult, AppContext } from '../webxdc-app.js'
import type { WebXDCUpdate } from '../dc-client.js'
import * as models from '../models.js'
import { loadAllLeaves, symmetricCombines } from '../leaves.js'
import { PATTERN_IDS, type PatternId } from '../agent-icons/palettes.js'
import { getCreateAgentVersion, buildCreateAgentXDC } from '../create-agent.js'
import {
  isControlCommandAuthorized,
  type ControlAuthDeps,
} from '../access/webxdc-control-auth.js'
import {
  handleBuildAgent,
  handleCreateAgent,
  resolveOwnerForChat,
  buildL2Summary,
  availableToolsPayload,
} from './agent-setup-app.js'

// ── Module-level state ───────────────────────────────────────────────────

/** Maps msgId → chatId for registered create cards. */
const createSessions = new Map<number, number>()

/** Production ControlAuthDeps — wired from server.ts via setControlAuthDeps(). */
let _controlAuthDeps: ControlAuthDeps | null = null

/**
 * Wire the production ControlAuthDeps. Called once from main() in server.ts
 * after `client`, `_currentDriver`, and `access` are all in scope.
 * Tests inject fakes by passing them directly to the exported handler
 * functions as the `auth` parameter.
 */
export function setControlAuthDeps(deps: ControlAuthDeps): void {
  _controlAuthDeps = deps
}

/**
 * Build + send the Create Agent card into `chatId` and ship the FLAT init
 * update carrying the catalog. Returns the sent message's msgId.
 *
 * Extracted from `dc_open_create_card`'s callTool body (increment 4, #109)
 * so other cards (agent-manage's "+ Create new agent" cross-card handoff)
 * can summon this card via a plain function call rather than duplicating
 * the build/send/register/init sequence.
 */
export async function openCreateCard(
  ctx: AppContext,
  chatId: number,
  seedLeaf: string | null,
): Promise<number> {
  const { xdcPath } = await buildCreateAgentXDC()
  const msgId = await ctx.client.sendWebXDC(chatId, xdcPath)
  createSessions.set(msgId, chatId)
  ctx.registerWebXDCMsg(msgId, createApp, chatId)

  // Send the FLAT init update carrying the catalog. The card reads
  // d.leaves / d.l2Summary / d.combines / d.seedLeaf /
  // d.availableModels / d.defaultModel / d.availableBuiltinTools /
  // d.availableMcpServers / d.connectedMcpServers at the TOP LEVEL —
  // do NOT nest under a newAgentFlow wrapper (the monolith's sendInit
  // shape). symmetricCombines() is already folded into each leaf's
  // combinesWith; the top-level `combines` is a stored-but-unused
  // catalog slot, sent empty.
  const leaves = loadAllLeaves()
  const sym = symmetricCombines()
  await ctx.client.sendWebXDCUpdate(msgId, JSON.stringify({
    payload: {
      type: 'init',
      version: getCreateAgentVersion(),
      senderAddr: 'server',
      leaves: leaves.map(l => ({
        id: l.id,
        path: l.path,
        l2: l.l2,
        name: l.name,
        parameter: l.parameter,
        liability: l.liability,
        pitch: l.pitch,
        combinesWith: [...(sym.get(l.id) ?? new Set<string>())].sort(),
      })),
      l2Summary: buildL2Summary(leaves),
      combines: [],
      seedLeaf,
      availableModels: models.MODELS.map(m => ({ id: m.id, label: m.label, tier: m.tier })),
      defaultModel: models.DEFAULT_MODEL,
      ...availableToolsPayload(ctx),
    },
    summary: 'Create agent',
    info: 'Tap to open Create Agent',
    href: 'index.html',
  }))

  return msgId
}

// ── WebXDCApp implementation ─────────────────────────────────────────────

export const createApp: WebXDCApp = {
  id: 'create-agent',

  tools(): ToolDef[] {
    return [
      {
        name: 'dc_open_create_card',
        description:
          'Open the Create Agent card in a chat. Lets the user browse the specialty ' +
          'catalog and build a new agent — either via a guided coach interview (combine ' +
          'specialties → answer a few questions in chat) or a direct form-create. ' +
          'Sends a self-contained WebXDC app card into the chat. ' +
          'chat_id is REQUIRED — pass the caller\'s bound chat ID (the chat you are operating in). ' +
          'seedLeaf is OPTIONAL — pass a leaf id (e.g. from "make me a sleep coach") to pre-select ' +
          'that specialty and open the wall at its detail card.',
        inputSchema: {
          type: 'object',
          properties: {
            chat_id: {
              type: 'string',
              description: 'DC chat ID to send the create card into. Should be the caller\'s bound chat.',
            },
            seedLeaf: {
              type: 'string',
              description: 'Optional leaf id to pre-select on the catalog wall.',
            },
          },
          required: ['chat_id'],
        },
        requiresCapability: 'infrastructure',
      },
    ]
  },

  async callTool(name: string, args: Record<string, unknown>, ctx: AppContext): Promise<ToolResult | null> {
    if (name !== 'dc_open_create_card') return null

    const rawChatId = args.chat_id
    const targetChatId = typeof rawChatId === 'string' && rawChatId.length > 0
      ? Number(rawChatId)
      : NaN

    if (!Number.isFinite(targetChatId)) {
      return {
        content: [{ type: 'text', text: 'dc_open_create_card: chat_id is required (the chat to open the create card in).' }],
        isError: true,
      }
    }

    const seedLeaf = typeof args.seedLeaf === 'string' && args.seedLeaf.length > 0
      ? args.seedLeaf
      : null

    try {
      await openCreateCard(ctx, targetChatId, seedLeaf)

      return {
        content: [{
          type: 'text',
          text: `Create card opened in chat ${targetChatId}${seedLeaf ? ` (seed=${seedLeaf})` : ''}.`,
        }],
      }
    } catch (err) {
      ctx.logf('create: dc_open_create_card failed: %v', err)
      return {
        content: [{ type: 'text', text: `dc_open_create_card failed: ${(err as Error).message}` }],
        isError: true,
      }
    }
  },

  async onWebXDCUpdate(msgId: number, updates: WebXDCUpdate[], ctx: AppContext): Promise<void> {
    const chatId = createSessions.get(msgId)
    if (chatId === undefined) {
      ctx.logf('create: onWebXDCUpdate for unregistered msgId %d', msgId)
      return
    }

    // Build the auth callback bound to this chatId.
    const auth = async (): Promise<{ ok: true } | { ok: false; reason: 'no-owner' | 'needs-confirmation' }> => {
      if (!_controlAuthDeps) {
        // Production deps not wired yet — shouldn't happen in real server,
        // fail safe by refusing.
        return { ok: false, reason: 'no-owner' }
      }
      return isControlCommandAuthorized(chatId, _controlAuthDeps)
    }

    for (const u of updates) {
      const payload = u.payload as {
        type?: string
        [key: string]: unknown
      } | null
      if (!payload) continue

      if (payload.type === 'build-agent') {
        // §6 gate first — refuse before any chat/agent mutation.
        const authResult = await auth()
        if (!authResult.ok) {
          const message = authResult.reason === 'needs-confirmation'
            ? "Creating an agent in a group has to come from you directly — send it as a message here (e.g. \"create an agent that ...\"), or open this card from your 1:1 chat with me."
            : 'No owner found for this chat.'
          await ctx.client.sendWebXDCUpdate(msgId, JSON.stringify({
            payload: { type: 'chat-failed', error: message, senderAddr: 'server' },
            summary: 'Create unauthorized',
          })).catch(() => {})
          continue
        }

        const rawLeafIds = (payload as { leafIds?: unknown }).leafIds
        const leafIds = Array.isArray(rawLeafIds)
          ? rawLeafIds.filter((x): x is string => typeof x === 'string' && x.length > 0)
          : []
        if (leafIds.length === 0) {
          await ctx.client.sendWebXDCUpdate(msgId, JSON.stringify({
            payload: { type: 'chat-failed', error: 'No specialties were sent.', senderAddr: 'server' },
            summary: 'Chat creation failed',
          })).catch(() => {})
          continue
        }
        // Phase 9.2: pattern picker on review screen. Validate against
        // PATTERN_IDS — fall back to 'checker' if missing or unknown so a
        // stale client still graduates with a sensible default.
        const rawPattern = (payload as { pattern?: unknown }).pattern
        const validPattern: PatternId =
          typeof rawPattern === 'string' && (PATTERN_IDS as readonly string[]).includes(rawPattern)
            ? (rawPattern as PatternId)
            : 'checker'

        const resolveOwner = () => resolveOwnerForChat(ctx, chatId)
        try {
          const newChatId = await handleBuildAgent(ctx, chatId, leafIds, validPattern, resolveOwner)
          await ctx.client.sendWebXDCUpdate(msgId, JSON.stringify({
            payload: { type: 'chat-ready', chatId: newChatId, senderAddr: 'server' },
            summary: 'Chat created',
          })).catch(() => {})
        } catch (err) {
          ctx.logf('create: build-agent failed: %v', err)
          await ctx.client.sendWebXDCUpdate(msgId, JSON.stringify({
            payload: { type: 'chat-failed', error: err instanceof Error ? err.message : 'unknown error', senderAddr: 'server' },
            summary: 'Chat creation failed',
          })).catch(() => {})
        }
        continue
      }

      if (payload.type === 'create') {
        // handleCreateAgent applies the §6 gate internally (same pattern
        // as handleAssignRole) and emits the created / create_err reply.
        await handleCreateAgent(ctx, msgId, chatId, payload, auth)
        continue
      }
    }
  },

  // #114: refill createSessions from the persisted card-session store at
  // boot so a card opened before a restart keeps answering taps.
  restoreSession(msgId: number, chatId: number): void {
    createSessions.set(msgId, chatId)
  },

  start(ctx: AppContext): void {
    ctx.logf('create: app started')
  },
}
