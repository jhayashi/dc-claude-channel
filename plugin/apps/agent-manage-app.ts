/**
 * Agent-manage WebXDC app — standalone bespoke card for the agent
 * management flow (show / edit / swap / reuse / rebind / delete). Split
 * out of the agent-setup monolith (increment 4, #109) and gated by the
 * §6 ControlAuthDeps helper, same as create-app.ts and contacts-app.ts.
 *
 * The card's actual mutation logic lives in the exported handlers on
 * agent-setup-app.ts (editRequest/saveEdit/delete/export/bind/
 * start-default-chat/start-reuse-chat/rebind-chat) — this app only opens
 * the card, ships the FLAT init, and relays each card action into the
 * shared handler, passing the §6 `auth` callback where a handler is
 * state-changing. "+ Create new agent" (`open-create`) is a cross-card
 * handoff: it gates on the same §6 auth, then calls `openCreateCard`
 * (extracted from create-app.ts) to summon the create-agent card into
 * the same chat — a webXDC card cannot summon another card client-side.
 *
 * Authorization note (§6): webXDC senderAddr is app-relayed and spoofable
 * (verified, dc-core 2.53). State-changing handlers MUST gate on
 * isControlCommandAuthorized rather than anything the card payload says.
 */

import type { WebXDCApp, ToolDef, ToolResult, AppContext } from '../webxdc-app.js'
import type { WebXDCUpdate } from '../dc-client.js'
import * as models from '../models.js'
import { getAgentManageVersion, buildAgentManageXDC } from '../agent-manage.js'
import { openCreateCard } from './create-app.js'
import {
  isControlCommandAuthorized,
  type ControlAuthDeps,
} from '../access/webxdc-control-auth.js'
import {
  handleEditRequest,
  handleSaveEdit,
  handleDeleteAgent,
  handleExportAgent,
  handleBindAgent,
  handleStartDefaultChat,
  handleStartReuseChat,
  handleRebindChat,
  resolveOwnerForChat,
  listExistingForPicker,
  availableToolsPayload,
} from './agent-setup-app.js'

// ── Module-level state ───────────────────────────────────────────────────

/** Maps msgId → chatId for registered agent-manage cards. */
const manageSessions = new Map<number, number>()

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

// ── WebXDCApp implementation ─────────────────────────────────────────────

export const agentManageApp: WebXDCApp = {
  id: 'agent-manage',

  tools(): ToolDef[] {
    return [
      {
        name: 'dc_open_agent_manage_card',
        description:
          'Open the Manage Agents card in a chat. Lets the user view, edit, delete, ' +
          'export, reuse, or rebind their existing agents, and start a new chat with ' +
          'the default assistant or a reused agent. Sends a self-contained WebXDC ' +
          'app card into the chat. ' +
          'chat_id is REQUIRED — pass the caller\'s bound chat ID (the chat you are operating in).',
        inputSchema: {
          type: 'object',
          properties: {
            chat_id: {
              type: 'string',
              description: 'DC chat ID to send the manage card into. Should be the caller\'s bound chat.',
            },
          },
          required: ['chat_id'],
        },
        requiresCapability: 'infrastructure',
      },
    ]
  },

  async callTool(name: string, args: Record<string, unknown>, ctx: AppContext): Promise<ToolResult | null> {
    if (name !== 'dc_open_agent_manage_card') return null

    const rawChatId = args.chat_id
    const targetChatId = typeof rawChatId === 'string' && rawChatId.length > 0
      ? Number(rawChatId)
      : NaN

    if (!Number.isFinite(targetChatId)) {
      return {
        content: [{ type: 'text', text: 'dc_open_agent_manage_card: chat_id is required (the chat to open the manage card in).' }],
        isError: true,
      }
    }

    try {
      const { xdcPath } = await buildAgentManageXDC()
      const msgId = await ctx.client.sendWebXDC(targetChatId, xdcPath)
      manageSessions.set(msgId, targetChatId)
      ctx.registerWebXDCMsg(msgId, agentManageApp, targetChatId)

      // ownerEmail resolves the same owner the §6 gate and the reuse/bind
      // flows use (resolveOwnerForChat) — the chat's paired human, falling
      // back to the first non-self member. Sent so the card can compare
      // window.webxdc.selfAddr against it (layer-1 cosmetic "not
      // permissioned" view — deferred, see design spec's Known limitation).
      const ownerContactId = await resolveOwnerForChat(ctx, targetChatId)
      const ownerEmail = ownerContactId
        ? (await ctx.client.getContact(ownerContactId))?.address ?? null
        : null

      // FLAT init: manage/edit fields at the TOP LEVEL, no newAgentFlow
      // catalog wrapper (creation is the separate create-agent card).
      await ctx.client.sendWebXDCUpdate(msgId, JSON.stringify({
        payload: {
          type: 'init',
          version: getAgentManageVersion(),
          existingAgents: await listExistingForPicker(targetChatId),
          availableModels: models.MODELS.map(m => ({ id: m.id, label: m.label, tier: m.tier })),
          defaultModel: models.DEFAULT_MODEL,
          ...availableToolsPayload(ctx),
          ownerEmail,
          senderAddr: 'server',
        },
        summary: 'Manage agents',
        info: 'Tap to manage your agents',
        href: 'index.html',
      }))

      return {
        content: [{ type: 'text', text: `Manage card opened in chat ${targetChatId}.` }],
      }
    } catch (err) {
      ctx.logf('agent-manage: dc_open_agent_manage_card failed: %v', err)
      return {
        content: [{ type: 'text', text: `dc_open_agent_manage_card failed: ${(err as Error).message}` }],
        isError: true,
      }
    }
  },

  async onWebXDCUpdate(msgId: number, updates: WebXDCUpdate[], ctx: AppContext): Promise<void> {
    const chatId = manageSessions.get(msgId)
    if (chatId === undefined) {
      ctx.logf('agent-manage: onWebXDCUpdate for unregistered msgId %d', msgId)
      return
    }

    // Build the auth callback bound to this chatId. Fail-safe: refuse when
    // production deps aren't wired yet (shouldn't happen in the real
    // server — setControlAuthDeps is called from main() before any card
    // can be opened — but never default to `{ok:true}`).
    const auth = async (): Promise<{ ok: true } | { ok: false; reason: 'no-owner' | 'needs-confirmation' }> => {
      if (!_controlAuthDeps) {
        return { ok: false, reason: 'no-owner' }
      }
      return isControlCommandAuthorized(chatId, _controlAuthDeps)
    }

    for (const u of updates) {
      const payload = u.payload as {
        type?: string
        agentId?: string
        [key: string]: unknown
      } | null
      if (!payload) continue

      const agentId = typeof payload.agentId === 'string' ? payload.agentId : ''

      switch (payload.type) {
        case 'editRequest':
          await handleEditRequest(ctx, msgId, chatId, agentId)
          break

        case 'saveEdit':
          await handleSaveEdit(ctx, msgId, chatId, payload, auth)
          break

        case 'delete':
          await handleDeleteAgent(ctx, msgId, chatId, agentId, auth)
          break

        case 'export':
          await handleExportAgent(ctx, msgId, chatId, agentId)
          break

        case 'bind':
          await handleBindAgent(ctx, msgId, chatId, payload, auth)
          break

        case 'start-default-chat':
          await handleStartDefaultChat(ctx, msgId, chatId, auth)
          break

        case 'start-reuse-chat':
          await handleStartReuseChat(ctx, msgId, chatId, agentId, auth)
          break

        case 'rebind-chat':
          await handleRebindChat(ctx, msgId, chatId, agentId, auth)
          break

        case 'open-create': {
          // Cross-card handoff: gate on the same §6 auth as any other
          // state-changing action (a create summoned from this card is
          // still "creating an agent from a control surface"), then open
          // the create-agent card into the same chat. On refusal emit the
          // same generic `action_err` the Task-2 handlers use so the card
          // needs only one refusal handler.
          const authResult = await auth()
          if (!authResult.ok) {
            const message = authResult.reason === 'needs-confirmation'
              ? 'That change has to come from you directly — say it in our chat, or open this from your 1:1 with me.'
              : 'No owner found for this chat.'
            await ctx.client.sendWebXDCUpdate(msgId, JSON.stringify({
              payload: { type: 'action_err', message, senderAddr: 'server' },
              summary: 'Action unauthorized',
            })).catch(() => {})
            break
          }
          await openCreateCard(ctx, chatId, null)
          break
        }

        default:
          break
      }
    }
  },

  start(ctx: AppContext): void {
    ctx.logf('agent-manage: app started')
  },
}
