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
 * §6 always refuses in multi-human groups — a webXDC tap has no reliable
 * per-tap identity to authorize against.
 *
 * `dc_rebind_chat` is a SEPARATE, directly-callable tool (not a card
 * action) for "switch this chat to <named agent>" via a chat message. It
 * deliberately has NO §6/auth callback: a chat message carries a real,
 * DC-core-verified `fromId`, so the dispatcher's standard capability gate
 * (requiresCapability: 'infrastructure', evaluated against that actual
 * sender) is sufficient authorization on its own — and unlike the card's
 * rebind action, it works in multi-human groups, since there's no
 * ambiguous-tapper problem to compensate for.
 */

import type { WebXDCApp, ToolDef, ToolResult, AppContext } from '../webxdc-app.js'
import type { WebXDCUpdate } from '../dc-client.js'
import * as models from '../models.js'
import * as agents from '../agents.js'
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
  refuseIfUnauthorized,
  rebindChat,
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

/**
 * Build + send the Manage Agents card into `chatId` and ship the FLAT
 * init update. Returns the sent message's msgId.
 *
 * Extracted from `dc_open_agent_manage_card`'s callTool body (increment 4,
 * #109) so the dispatcher side (server.ts's native-moment offer, the
 * permissions card's "manage" hand-off) can summon this card via a plain
 * function call instead of the retired monolith's card-summon helper.
 */
export async function openManageCard(
  ctx: AppContext,
  chatId: number,
  view: 'manage' | 'switch' = 'manage',
): Promise<number> {
  const { xdcPath } = await buildAgentManageXDC()
  const msgId = await ctx.client.sendWebXDC(chatId, xdcPath)
  manageSessions.set(msgId, chatId)
  ctx.registerWebXDCMsg(msgId, agentManageApp, chatId)

  // ownerEmail resolves the same owner the §6 gate and the reuse/bind
  // flows use (resolveOwnerForChat) — the chat's paired human, falling
  // back to the first non-self member. Sent so the card can compare
  // window.webxdc.selfAddr against it (layer-1 cosmetic "not
  // permissioned" view — deferred, see design spec's Known limitation).
  const ownerContactId = await resolveOwnerForChat(ctx, chatId)
  const ownerEmail = ownerContactId
    ? (await ctx.client.getContact(ownerContactId))?.address ?? null
    : null

  // FLAT init: manage/edit fields at the TOP LEVEL, no newAgentFlow
  // catalog wrapper (creation is the separate create-agent card).
  await ctx.client.sendWebXDCUpdate(msgId, JSON.stringify({
    payload: {
      type: 'init',
      version: getAgentManageVersion(),
      view,
      existingAgents: await listExistingForPicker(chatId),
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

  return msgId
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
          'export, or switch/rebind their existing agents, and start a new chat with ' +
          'the default assistant or a reused agent. Sends a self-contained WebXDC ' +
          'app card into the chat. ' +
          'Use this when the user wants to BROWSE or is vague about which agent ' +
          '(e.g. "switch my agent", "manage my agents") — open the card rather than ' +
          'listing agents in text or describing manual steps. If the user names a ' +
          'SPECIFIC existing agent to switch to (e.g. "switch this chat to dc-developer"), ' +
          'call dc_rebind_chat directly instead — no card needed for a fully-specified request. ' +
          'chat_id is REQUIRED — pass the caller\'s bound chat ID (the chat you are operating in). ' +
          'view is OPTIONAL — pass \'switch\' to open DIRECTLY on the pick-an-agent (rebind) screen ' +
          '(use this for "switch/change this chat\'s agent" with no name given); omit or \'manage\' opens the agent list.',
        inputSchema: {
          type: 'object',
          properties: {
            chat_id: {
              type: 'string',
              description: 'DC chat ID to send the manage card into. Should be the caller\'s bound chat.',
            },
            view: {
              type: 'string',
              // #135: accept the spec's Appendix-A vocabulary (show/edit/swap)
              // as aliases — a well-read model passing view:'edit' was
              // silently coerced to the list with no signal.
              enum: ['manage', 'switch', 'show', 'swap', 'edit'],
              description: '\'switch\' (alias \'swap\') opens the pick-an-agent (rebind) screen directly — use for "switch this chat\'s agent". \'manage\' (aliases \'show\', \'edit\'; default) opens the agent list — each agent\'s edit screen is one tap from there.',
            },
          },
          required: ['chat_id'],
        },
        requiresCapability: 'infrastructure',
      },
      {
        name: 'dc_rebind_chat',
        description:
          'Switch THIS chat directly to a different, already-known agent — immediate ' +
          'effect, no card. Use this when the user names a SPECIFIC existing agent ' +
          '(e.g. "switch this chat to dc-developer", "rebind to Patient Advocate") — a ' +
          'fully-specified request should just happen. If the user is vague (no agent ' +
          'named) or wants to browse options, call dc_open_agent_manage_card with ' +
          'view:\'switch\' instead so they can pick from a list. ' +
          'Unlike the card\'s rebind action, this works even in multi-human groups: it is ' +
          'authorized by who actually SENT this message (a real, authenticated chat message), ' +
          'not by an unauthenticated webXDC tap — so it is the answer to "that has to come ' +
          'from you directly, say it in our chat". ' +
          'chat_id is REQUIRED — the chat to rebind (the chat you are operating in). ' +
          'agent_id is REQUIRED — the target agent\'s canonical name (slug). If you only know ' +
          'a display name, resolve it first (e.g. via dc_open_agent_manage_card\'s agent list). ' +
          'keep_context is OPTIONAL (default false) — pass true only if the user explicitly asks ' +
          'to keep/preserve the conversation; by default rebinding starts a fresh session for ' +
          'the new agent (a full identity swap shouldn\'t carry the old agent\'s transcript).',
        inputSchema: {
          type: 'object',
          properties: {
            chat_id: {
              type: 'string',
              description: 'DC chat ID to rebind. Should be the caller\'s bound chat.',
            },
            agent_id: {
              type: 'string',
              description: 'Canonical (slug) name of the target agent to switch this chat to.',
            },
            keep_context: {
              type: 'boolean',
              description: 'Preserve the current conversation/session instead of starting fresh. Default false.',
            },
          },
          required: ['chat_id', 'agent_id'],
        },
        requiresCapability: 'infrastructure',
      },
    ]
  },

  async callTool(name: string, args: Record<string, unknown>, ctx: AppContext): Promise<ToolResult | null> {
    if (name === 'dc_open_agent_manage_card') {
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

      // 'swap' is the spec's word for the rebind screen (#135 alias).
      const view = (args.view === 'switch' || args.view === 'swap') ? 'switch' : 'manage'

      try {
        await openManageCard(ctx, targetChatId, view)
        return {
          content: [{ type: 'text', text: `Manage card opened in chat ${targetChatId}${view === 'switch' ? ' (pick-an-agent view)' : ''}.` }],
        }
      } catch (err) {
        ctx.logf('agent-manage: dc_open_agent_manage_card failed: %v', err)
        return {
          content: [{ type: 'text', text: `dc_open_agent_manage_card failed: ${(err as Error).message}` }],
          isError: true,
        }
      }
    }

    if (name === 'dc_rebind_chat') {
      // NO §6/auth callback here by design: this tool is only reachable via
      // a real, DC-core-authenticated chat message (fromId), not an
      // unauthenticated webXDC tap. The dispatcher's capability gate
      // (requiresCapability: 'infrastructure', resolved against the actual
      // message sender — see access/gate.ts + server.ts's _currentDriver)
      // already authorizes the call before callTool ever runs, so it works
      // correctly in multi-human groups where the card's rebind action
      // (§6-gated) always refuses.
      const rawChatId = args.chat_id
      const targetChatId = typeof rawChatId === 'string' && rawChatId.length > 0
        ? Number(rawChatId)
        : NaN
      if (!Number.isFinite(targetChatId)) {
        return {
          content: [{ type: 'text', text: 'dc_rebind_chat: chat_id is required (the chat to rebind).' }],
          isError: true,
        }
      }

      const agentId = typeof args.agent_id === 'string' ? args.agent_id : ''
      if (!agentId) {
        return {
          content: [{ type: 'text', text: 'dc_rebind_chat: agent_id is required (the target agent\'s canonical name).' }],
          isError: true,
        }
      }

      const agent = agents.getAgent(agentId)
      if (!agent) {
        return {
          content: [{ type: 'text', text: `dc_rebind_chat: agent "${agentId}" not found.` }],
          isError: true,
        }
      }

      const keepContext = args.keep_context === true

      try {
        await rebindChat(ctx, targetChatId, agent, { keepContext })
        return {
          content: [{
            type: 'text',
            text: `Chat ${targetChatId} switched to "${agent.name}"` +
              `${keepContext ? ' (kept the current conversation)' : ' (started a fresh conversation)'}.`,
          }],
        }
      } catch (err) {
        ctx.logf('agent-manage: dc_rebind_chat failed: %v', err)
        return {
          content: [{ type: 'text', text: `dc_rebind_chat failed: ${(err as Error).message}` }],
          isError: true,
        }
      }
    }

    return null
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
          await handleRebindChat(ctx, msgId, chatId, agentId, payload.keepContext === true, auth)
          break

        case 'open-create': {
          // Cross-card handoff: gate on the same §6 auth as any other
          // state-changing action (a create summoned from this card is
          // still "creating an agent from a control surface"). refuseIfUnauthorized
          // emits the shared `action_err` on refusal (one refusal handler in the
          // card), so we don't duplicate that copy here (#117).
          if (await refuseIfUnauthorized(ctx, msgId, auth)) break
          // Wrap the summon: if openCreateCard throws (e.g. sendWebXDC fails),
          // still tell the card instead of leaving it silent — symmetry with
          // dc_open_create_card's own error path (#117).
          try {
            await openCreateCard(ctx, chatId, null)
          } catch (err) {
            ctx.logf('agent-manage: open-create failed: %v', err)
            await ctx.client.sendWebXDCUpdate(msgId, JSON.stringify({
              payload: { type: 'action_err', message: 'Could not open the create-agent card — try again.', senderAddr: 'server' },
              summary: 'Open create failed',
            })).catch(() => {})
          }
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
