/**
 * Agent setup WebXDC app — sends a setup card into a paired chat that
 * lets the user pick an existing agent to reuse OR create a new one
 * from scratch. On confirm, creates a new DC chat (if needed) and
 * persists an agent definition + binding per the 2026-04-09 spec.
 */

import type { WebXDCApp, ToolDef, ToolResult, AppContext } from '../webxdc-app.js'
import type { WebXDCUpdate } from '../dc-client.js'
import * as agentSetup from '../agent-setup.js'
import * as agents from '../agents.js'
import * as bindings from '../bindings.js'
import * as access from '../access.js'

/**
 * Server-side draft carried between sendInit and the user confirming.
 * Extends DraftAgent with a private _inheritClaudeMd field that lives
 * on the binding (not the agent definition). The WebXDC echoes this
 * back in the `create` payload so the server knows what to save on
 * the binding.
 */
interface ServerDraft extends agents.DraftAgent {
  _inheritClaudeMd: boolean
}

interface Session {
  msgId: number
  sourceChatId: number
  draft: ServerDraft
}

// Sessions are keyed by the chat the user is messaging from (source chat).
// One active setup card per source chat.
const sessions = new Map<number, Session>()

/** Per-type defaults for the WebXDC to swap in when the user changes type. */
function defaultsByType(): Record<agents.AgentType, { system: string; model: string; inheritClaudeMd: boolean }> {
  const out: Partial<Record<agents.AgentType, { system: string; model: string; inheritClaudeMd: boolean }>> = {}
  for (const [k, v] of Object.entries(agents.AGENT_TYPES) as Array<[agents.AgentType, typeof agents.AGENT_TYPES[agents.AgentType]]>) {
    out[k] = { system: v.defaultPrompt, model: v.model, inheritClaudeMd: v.inheritClaudeMd }
  }
  return out as Record<agents.AgentType, { system: string; model: string; inheritClaudeMd: boolean }>
}

/** Summarize agents for the picker screen. */
function listExistingForPicker(sourceChatId: number): Array<{ id: string; name: string; type: string; description: string; bindingCount: number; isCurrentAgent: boolean }> {
  const sourceBinding = bindings.getBinding(sourceChatId)
  return agents.listAgents().map(a => ({
    id: a.id,
    name: a.name,
    type: a['x-dc-type'],
    description: a['x-dc-description'] ?? '',
    bindingCount: bindings.countByAgentId(a.id),
    isCurrentAgent: sourceBinding?.agentId === a.id,
  }))
}

async function sendInit(
  ctx: AppContext,
  app: WebXDCApp,
  sourceChatId: number,
  draft: ServerDraft,
): Promise<Session> {
  // Reuse existing session if present.
  const existing = sessions.get(sourceChatId)
  const payload = {
    type: 'init' as const,
    version: agentSetup.getAgentSetupVersion(),
    draft: { ...draft, _defaultsByType: defaultsByType() },
    existingAgents: listExistingForPicker(sourceChatId),
  }
  // Info text MUST be unique per call — DC dedupes consecutive identical
  // info text and the user gets no notification. Include the draft name
  // so each setup card produces a fresh tappable info message.
  const prefix = 'Tap to create agent: '
  const maxName = 80 - prefix.length
  const shortName = draft.name.length > maxName ? draft.name.slice(0, maxName - 1) + '\u2026' : draft.name
  const update = JSON.stringify({
    payload,
    summary: 'Agent setup',
    info: prefix + shortName,
    href: 'index.html',
  })

  if (existing) {
    existing.draft = draft
    await ctx.client.sendWebXDCUpdate(existing.msgId, update)
    return existing
  }

  const { xdcPath } = await agentSetup.buildAgentSetupXDC()
  const msgId = await ctx.client.sendWebXDC(sourceChatId, xdcPath)
  try {
    const { unlinkSync } = await import('node:fs')
    unlinkSync(xdcPath)
  } catch {}
  await ctx.client.sendWebXDCUpdate(msgId, update)
  const session: Session = { msgId, sourceChatId, draft }
  sessions.set(sourceChatId, session)
  ctx.registerWebXDCMsg(msgId, app, sourceChatId)
  ctx.logf('agent-setup: sent app (msg %d) to chat %d', msgId, sourceChatId)
  return session
}

/** Apply icon + intro message after a chat has been bound to an agent. */
async function decorateAgentChat(
  ctx: AppContext,
  chatId: number,
  agent: agents.AgentDef,
): Promise<void> {
  try {
    const variant = Math.floor(Math.random() * 3) + 1 // 1-3
    const iconMap: Record<string, string> = {
      quick: `quick-dog-${variant}.png`,
      basic: `basic-dolphin-${variant}.png`,
      coding: `coding-elephant-${variant}.png`,
    }
    const iconName = iconMap[agent['x-dc-type']] || 'quick-dog-1.png'
    const iconPath = new URL(`../assets/agent-icons/${iconName}`, import.meta.url).pathname
    await ctx.client.setChatProfileImage(chatId, iconPath)
    ctx.logf('agent-setup: set agent icon to %s', iconName)
  } catch (err) {
    ctx.logf('agent-setup: set icon failed: %v', err)
  }

  try {
    await ctx.client.send(
      chatId,
      `Hi! This is your new "${agent.name}" agent (${agent['x-dc-type']}). Send a message here to get started.`,
    )
  } catch (err) {
    ctx.logf('agent-setup: intro message send failed: %v', err)
  }
}

export const agentSetupApp: WebXDCApp = {
  id: 'agent-setup',

  instructions:
    'When the user wants to create a new agent with a specific behavior ' +
    '(coding assistant, quick Q&A, general chat, etc.), call dc_propose_agent with ' +
    'their description. This sends an agent setup card to the chat for them to review and create.',

  tools(): ToolDef[] {
    return [
      {
        name: 'dc_propose_agent',
        description:
          'Send an agent setup card to the user. The card lets them reuse an ' +
          'existing agent definition or create a new one by picking a type and ' +
          'editing the name/prompt. In either case, a new DC chat is created on confirm.',
        inputSchema: {
          type: 'object',
          properties: {
            source_chat_id: {
              type: 'string',
              description: 'The chat the user is messaging from (where to send the setup card).',
            },
            description: {
              type: 'string',
              description: 'Free-form description of what the agent is for.',
            },
          },
          required: ['source_chat_id', 'description'],
        },
      },
    ]
  },

  async callTool(name: string, args: Record<string, unknown>, ctx: AppContext): Promise<ToolResult | null> {
    if (name !== 'dc_propose_agent') return null

    const sourceChatId = Number(args.source_chat_id as string)
    if (!sourceChatId || Number.isNaN(sourceChatId)) {
      return { content: [{ type: 'text', text: 'dc_propose_agent: invalid source_chat_id' }], isError: true }
    }
    if (!ctx.isAllowed(sourceChatId)) {
      return { content: [{ type: 'text', text: `dc_propose_agent: chat ${sourceChatId} not allowed` }], isError: true }
    }
    const description = ((args.description as string) ?? '').trim()
    if (!description) {
      return { content: [{ type: 'text', text: 'dc_propose_agent: description is required' }], isError: true }
    }

    const { agent, inheritClaudeMd } = agents.draftAgentFromDescription(description)
    const draft: ServerDraft = { ...agent, _inheritClaudeMd: inheritClaudeMd }
    try {
      await sendInit(ctx, agentSetupApp, sourceChatId, draft)
    } catch (err) {
      ctx.logf('agent-setup: send failed: %v', err)
      return { content: [{ type: 'text', text: `dc_propose_agent: send failed: ${(err as Error).message}` }], isError: true }
    }

    return {
      content: [{
        type: 'text',
        text: `Setup card sent to chat ${sourceChatId} (drafted as type=${draft['x-dc-type']}, model=${draft.model}). Tap to review and confirm.`,
      }],
    }
  },

  async onWebXDCUpdate(msgId: number, updates: WebXDCUpdate[], ctx: AppContext): Promise<void> {
    // Find the session for this msgId.
    let session: Session | null = null
    for (const s of sessions.values()) {
      if (s.msgId === msgId) { session = s; break }
    }
    if (!session) return

    for (const u of updates) {
      const payload = u.payload as {
        type?: string
        config?: unknown
        agentId?: string
        inheritClaudeMd?: boolean
        appVersion?: number
        serverVersion?: number
      } | null
      if (!payload) continue

      if (payload.type === 'version_mismatch') {
        // Guard against double-handling.
        const current = sessions.get(session.sourceChatId)
        if (!current || current.msgId !== msgId) return
        ctx.logf('agent-setup: version mismatch from chat %d, resending app', session.sourceChatId)
        ctx.unregisterWebXDCMsg(msgId)
        sessions.delete(session.sourceChatId)
        try {
          await sendInit(ctx, agentSetupApp, session.sourceChatId, session.draft)
        } catch (err) {
          ctx.logf('agent-setup: resend after version mismatch failed: %v', err)
        }
        return
      }

      // Resolve the owner contact for the new chat (1:1 source: extract from
      // contacts; group source: use the stored owner).
      const resolveOwner = async (): Promise<number | null> => {
        let ownerContactId = access.getOwner(session!.sourceChatId)
        if (ownerContactId) return ownerContactId
        try {
          const contacts = await ctx.client.getChatContacts(session!.sourceChatId)
          const found = contacts.find(id => id !== 1)
          if (!found) {
            ctx.logf('agent-setup: could not find contact in source chat %d', session!.sourceChatId)
            return null
          }
          return found
        } catch (err) {
          ctx.logf('agent-setup: getChatContacts failed for chat %d: %v', session!.sourceChatId, err)
          return null
        }
      }

      if (payload.type === 'bind') {
        // Reuse an existing agent definition in a new DC chat.
        const agentId = typeof payload.agentId === 'string' ? payload.agentId : ''
        if (!agentId) {
          ctx.logf('agent-setup: bind payload missing agentId')
          continue
        }
        const agent = agents.getAgent(agentId)
        if (!agent) {
          ctx.logf('agent-setup: bind requested agent %s not found', agentId)
          continue
        }
        const ownerContactId = await resolveOwner()
        if (!ownerContactId) continue

        try {
          const newChatId = await ctx.client.createGroup(agent.name)
          await ctx.client.addContactToChat(newChatId, ownerContactId)
          access.addChat(newChatId, ownerContactId)
          bindings.bindAgent(newChatId, agent.id, {
            inheritClaudeMd: agents.AGENT_TYPES[agent['x-dc-type']].inheritClaudeMd,
          })
          await decorateAgentChat(ctx, newChatId, agent)
          ctx.logf('agent-setup: bound existing agent %s to new chat %d for owner %d', agent.id, newChatId, ownerContactId)

          const update = JSON.stringify({
            payload: { type: 'created', chatId: newChatId, name: agent.name },
            summary: 'Agent created',
          })
          await ctx.client.sendWebXDCUpdate(session.msgId, update)

          ctx.unregisterWebXDCMsg(msgId)
          sessions.delete(session.sourceChatId)
        } catch (err) {
          ctx.logf('agent-setup: bind failed: %v', err)
        }
        continue
      }

      if (payload.type === 'create') {
        const parsed = agents.DraftAgentSchema.safeParse(payload.config)
        if (!parsed.success) {
          ctx.logf('agent-setup: invalid config from chat %d: %v', session.sourceChatId, parsed.error)
          continue
        }
        const draft = parsed.data
        const inheritClaudeMd = payload.inheritClaudeMd ?? session.draft._inheritClaudeMd
        const ownerContactId = await resolveOwner()
        if (!ownerContactId) continue

        const agentId = agents.synthesizeAgentId(draft.name)
        try {
          const newChatId = await ctx.client.createGroup(draft.name)
          await ctx.client.addContactToChat(newChatId, ownerContactId)
          access.addChat(newChatId, ownerContactId)
          agents.saveAgent({ ...draft, id: agentId })
          bindings.bindAgent(newChatId, agentId, { inheritClaudeMd })
          const savedAgent = agents.getAgent(agentId)
          if (savedAgent) await decorateAgentChat(ctx, newChatId, savedAgent)
          ctx.logf('agent-setup: created agent %s for chat %d (owner %d)', agentId, newChatId, ownerContactId)

          const update = JSON.stringify({
            payload: { type: 'created', chatId: newChatId, name: draft.name },
            summary: 'Agent created',
          })
          await ctx.client.sendWebXDCUpdate(session.msgId, update)

          ctx.unregisterWebXDCMsg(msgId)
          sessions.delete(session.sourceChatId)
        } catch (err) {
          ctx.logf('agent-setup: create failed: %v', err)
          // Roll back the agent file if it was written but binding failed.
          try { agents.deleteAgent(agentId) } catch {}
        }
      }
    }
  },
}
