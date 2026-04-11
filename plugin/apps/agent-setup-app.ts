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

interface Session {
  msgId: number
  sourceChatId: number
  draft: agents.DraftAgent
}

// Sessions are keyed by the chat the user is messaging from (source chat).
// One active setup card per source chat.
const sessions = new Map<number, Session>()

/** Summarize agents for the picker screen. */
function listExistingForPicker(sourceChatId: number): Array<{ id: string; name: string; model: string; bindingCount: number; isCurrentAgent: boolean }> {
  const sourceBinding = bindings.getBinding(sourceChatId)
  return agents.listAgents().map(a => ({
    id: a.id,
    name: a.name,
    model: a.model,
    bindingCount: bindings.countByAgentId(a.id),
    isCurrentAgent: sourceBinding?.agentId === a.id,
  }))
}

/** Delete the agent if it has no remaining bindings. */
async function removeBindingIfOrphaned(ctx: AppContext, agentId: string): Promise<void> {
  if (agents.isOrphaned(agentId)) {
    try {
      agents.deleteAgent(agentId)
      ctx.logf('agent-setup: auto-deleted orphaned agent %s', agentId)
    } catch (err) {
      ctx.logf('agent-setup: auto-delete failed for %s: %v', agentId, err)
    }
  }
}

async function sendInit(
  ctx: AppContext,
  app: WebXDCApp,
  sourceChatId: number,
  draft: agents.DraftAgent,
): Promise<Session> {
  // Reuse existing session if present.
  const existing = sessions.get(sourceChatId)
  const payload = {
    type: 'init' as const,
    version: agentSetup.getAgentSetupVersion(),
    draft: {
      ...draft,
      skipPermissions: agents.getSkipPermissions(draft as agents.AgentDef),
      iconMirror: agents.getIconMirror(draft as agents.AgentDef),
    },
    existingAgents: listExistingForPicker(sourceChatId),
    senderAddr: 'server',
  }
  // Info text MUST be unique per call — DC dedupes consecutive identical
  // info text and the user gets no notification. Include the draft name
  // so each setup card produces a fresh tappable info message.
  const prefix = 'Agent setup: '
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

/** Icon filename per model, with -skip and -mirror orientation variants. */
const MODEL_ICON_BASE: Record<string, string> = {
  'claude-opus-4-6': 'agent-opus',
  'claude-sonnet-4-6': 'agent-sonnet',
  'claude-haiku-4-5': 'agent-haiku',
}

export function iconFilenameFor(
  model: string,
  skipPermissions: boolean,
  mirror: boolean,
): string {
  const base = MODEL_ICON_BASE[model] || 'agent-sonnet'
  const skipPart = skipPermissions ? '-skip' : ''
  const mirrorPart = mirror ? '-mirror' : ''
  return `${base}${skipPart}${mirrorPart}.png`
}

/** Minimal context for decorating agent chats (icon + welcome). */
export interface DecorateContext {
  client: Pick<import('../dc-client.js').DCClient, 'setChatProfileImage' | 'send'>
  logf: (format: string, ...args: unknown[]) => void
}

/** Set the chat profile image to the model/permission/orientation icon. */
export async function setAgentIcon(
  ctx: DecorateContext,
  chatId: number,
  model: string,
  skipPermissions: boolean,
  mirror: boolean,
): Promise<void> {
  const iconName = iconFilenameFor(model, skipPermissions, mirror)
  const iconPath = new URL(`../assets/agent-icons/${iconName}`, import.meta.url).pathname
  await ctx.client.setChatProfileImage(chatId, iconPath)
  ctx.logf('agent-setup: set agent icon to %s for chat %d', iconName, chatId)
}

/** Apply icon + intro message after a chat has been bound to an agent. */
export async function decorateAgentChat(
  ctx: DecorateContext,
  chatId: number,
  agent: agents.AgentDef,
): Promise<void> {
  try {
    await setAgentIcon(
      ctx,
      chatId,
      agent.model,
      agents.getSkipPermissions(agent),
      agents.getIconMirror(agent),
    )
  } catch (err) {
    ctx.logf('agent-setup: set icon failed: %v', err)
  }

  try {
    await ctx.client.send(
      chatId,
      `Hi! This is your new "${agent.name}" agent. Send a message here to get started.`,
    )
  } catch (err) {
    ctx.logf('agent-setup: intro message send failed: %v', err)
  }
}

export const agentSetupApp: WebXDCApp = {
  id: 'agent-setup',

  instructions:
    'CRITICAL — AGENT MANAGEMENT RULES:\n' +
    '1. When the user mentions ANYTHING about agents — creating, editing, deleting, ' +
    'managing, settings, "agent app", "agent card", "settings app", "send me the app", ' +
    '"change the model", "change my prompt", "edit this agent" — you MUST call ' +
    'dc_propose_agent. No exceptions.\n' +
    '2. NEVER build or send agent-setup.xdc yourself via Bash/dc_send_webxdc. ' +
    'NEVER read agent-setup.ts or agent-setup-app.ts. NEVER read or edit agent YAML files.\n' +
    '3. NEVER offer to change agent settings through conversation.\n' +
    '4. dc_propose_agent is the ONLY way to manage agents. It sends a setup card ' +
    'that handles everything: create, edit, delete, bind.\n' +
    '5. Use a short description (e.g. "manage agents", "edit agent settings").',

  tools(): ToolDef[] {
    return [
      {
        name: 'dc_propose_agent',
        description:
          'Send an agent setup card to the user. The card lets them create new ' +
          'agents, reuse existing ones, edit agent settings (name, model, prompt), ' +
          'or delete agents. Call this whenever the user asks about agent management.',
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
            model: {
              type: 'string',
              description: 'Suggested model. Use opus for coding/software tasks, haiku for simple Q&A, sonnet for everything else.',
              enum: ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-6'],
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

    const modelArg = args.model as string | undefined
    const model = modelArg && agents.ALLOWED_MODELS.includes(modelArg as agents.AllowedModel)
      ? modelArg as agents.AllowedModel
      : undefined
    const { agent } = agents.draftAgentFromDescription(description, model)
    try {
      await sendInit(ctx, agentSetupApp, sourceChatId, agent)
    } catch (err) {
      ctx.logf('agent-setup: send failed: %v', err)
      return { content: [{ type: 'text', text: `dc_propose_agent: send failed: ${(err as Error).message}` }], isError: true }
    }

    return {
      content: [{
        type: 'text',
        text: `Setup card sent to chat ${sourceChatId} (drafted as model=${agent.model}). Tap to review and confirm.`,
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

      if (payload.type === 'editRequest') {
        // Edit an existing agent. Re-open the setup card with the agent pre-filled.
        const agentId = typeof payload.agentId === 'string' ? payload.agentId : ''
        if (!agentId) {
          ctx.logf('agent-setup: edit payload missing agentId')
          continue
        }
        const agent = agents.getAgent(agentId)
        if (!agent) {
          ctx.logf('agent-setup: edit requested agent %s not found', agentId)
          continue
        }
        const editDraft = {
          id: agent.id,
          name: agent.name,
          model: agent.model,
          system: agent.system,
          tools: agent.tools ?? [],
          skipPermissions: agents.getSkipPermissions(agent),
          iconMirror: agents.getIconMirror(agent),
        }
        try {
          const update = JSON.stringify({
            payload: {
              type: 'edit',
              draft: editDraft,
              version: agentSetup.getAgentSetupVersion(),
              senderAddr: 'server',
            },
            summary: 'Editing agent',
          })
          await ctx.client.sendWebXDCUpdate(session.msgId, update)
          ctx.logf('agent-setup: sent edit screen for agent %s', agentId)
        } catch (err) {
          ctx.logf('agent-setup: edit send failed: %v', err)
        }
        continue
      }

      if (payload.type === 'delete') {
        const agentId = typeof payload.agentId === 'string' ? payload.agentId : ''
        if (!agentId) {
          ctx.logf('agent-setup: delete payload missing agentId')
          continue
        }
        const agent = agents.getAgent(agentId)
        if (!agent) {
          ctx.logf('agent-setup: delete requested agent %s not found', agentId)
          continue
        }
        try {
          // Unbind affected chats: notify, evict subagents, delete bindings.
          // Auto-repair in spawnSubagentForChat will bind them to default-quick-agent
          // on the next message.
          const affected = bindings.listBindings().filter(b => b.agentId === agentId)
          if (affected.length > 0) {
            await Promise.all(
              affected.map(b =>
                ctx.client.send(
                  b.chatId,
                  `The "${agent.name}" agent was deleted. This chat will use a default assistant.`,
                ).catch(() => {}),
              ),
            )
            await Promise.all(
              affected.map(async b => {
                await ctx.evictSubagent(b.chatId)
                bindings.deleteBinding(b.chatId)
              }),
            )
            ctx.logf('agent-setup: unbound %d chat(s) from agent %s', affected.length, agentId)
          }

          agents.deleteAgent(agentId)
          ctx.logf('agent-setup: deleted agent %s', agentId)
          const update = JSON.stringify({
            payload: {
              type: 'deleted',
              name: agent.name,
              existingAgents: listExistingForPicker(session.sourceChatId),
              version: agentSetup.getAgentSetupVersion(),
              senderAddr: 'server',
            },
            summary: 'Agent deleted',
          })
          await ctx.client.sendWebXDCUpdate(session.msgId, update)
          // Keep the session alive — user stays on the main screen
          // and may want to delete/edit more agents.
        } catch (err) {
          ctx.logf('agent-setup: delete failed: %v', err)
        }
        continue
      }

      if (payload.type === 'saveEdit') {
        const agentId = typeof payload.agentId === 'string' ? payload.agentId : ''
        if (!agentId) {
          ctx.logf('agent-setup: saveEdit missing agentId')
          continue
        }
        const agent = agents.getAgent(agentId)
        if (!agent) {
          ctx.logf('agent-setup: saveEdit requested agent %s not found', agentId)
          continue
        }
        const parsed = agents.DraftAgentSchema.safeParse(payload.config)
        if (!parsed.success) {
          ctx.logf('agent-setup: invalid config from chat %d: %v', session.sourceChatId, parsed.error)
          continue
        }
        const draft = parsed.data
        const skipPerms = (payload as { skipPermissions?: boolean }).skipPermissions === true
        const iconMirror = (payload as { iconMirror?: boolean }).iconMirror === true
        // Snapshot the pre-edit state BEFORE mutating metadata below. We
        // must clone metadata because `updated` shares the object otherwise,
        // and the setters mutate in place — which would make the "changed"
        // checks below always return false.
        const prevModel = agent.model
        const prevSystem = agent.system
        const prevSkip = agents.getSkipPermissions(agent)
        const prevMirror = agents.getIconMirror(agent)
        try {
          // Preserve existing metadata (e.g. x-dc-createdAt) across edits, then
          // apply the new skipPermissions / iconMirror flags. Clone to avoid
          // aliasing the original `agent.metadata` reference.
          const updated: agents.AgentDef = {
            ...draft,
            id: agentId,
            metadata: agent.metadata ? { ...agent.metadata } : undefined,
          }
          agents.setSkipPermissions(updated, skipPerms)
          agents.setIconMirror(updated, iconMirror)
          agents.saveAgent(updated)
          ctx.logf(
            'agent-setup: edited agent %s (model=%s skip=%s mirror=%s)',
            agentId, draft.model, skipPerms, iconMirror,
          )

          // Evict all cached subagents bound to this agent so they respawn
          // with the new model/prompt on the next message. Also update
          // inheritClaudeMd on each binding in case the model changed
          // (e.g. haiku→sonnet flips inherit from false→true).
          //
          // If the model changed, clear session IDs too — Claude Code's
          // built-in system prompt ("You are powered by model X") is baked
          // into the session store at creation time and replayed on resume.
          // There's no way to override it, so a model change requires a
          // fresh session.
          const modelChanged = prevModel !== draft.model
          const systemChanged = prevSystem !== draft.system
          const skipPermsChanged = prevSkip !== skipPerms
          const mirrorChanged = prevMirror !== iconMirror
          // Restart only for changes that are baked in at subagent spawn
          // time: the model (passed as --model and cached in the session
          // store) and the system prompt (read from disk at spawn). Cosmetic
          // changes (name, icon orientation) and skipPermissions — which the
          // dispatcher re-reads on every hook call — don't need a restart.
          const needsRestart = modelChanged || systemChanged
          const iconChanged = modelChanged || skipPermsChanged || mirrorChanged
          const affected = bindings.listBindings().filter(b => b.agentId === agentId)
          const newInherit = agents.inheritClaudeMdForModel(draft.model)

          // Notify affected chats before evicting so the user knows
          // the pause is intentional, not a hang.
          if (needsRestart && affected.length > 0) {
            const restartMsg = modelChanged
              ? `Agent updated. Restarting with new model (${draft.model.replace('claude-', '')})...`
              : 'Agent updated. Restarting...'
            await Promise.all(
              affected.map(b => ctx.client.send(b.chatId, restartMsg).catch(() => {})),
            )
          }

          await Promise.all(
            affected.map(async b => {
              if (b.inheritClaudeMd !== newInherit) {
                bindings.saveBinding({ ...b, inheritClaudeMd: newInherit })
              }
              if (modelChanged) {
                bindings.clearSessionId(b.chatId)
              }
              if (iconChanged) {
                await setAgentIcon(ctx, b.chatId, draft.model, skipPerms, iconMirror).catch(err =>
                  ctx.logf('agent-setup: icon update failed chat=%d: %v', b.chatId, err),
                )
              }
              if (needsRestart) {
                await ctx.evictSubagent(b.chatId)
              }
            }),
          )
          if (needsRestart && affected.length > 0) {
            ctx.logf(
              'agent-setup: evicted %d subagent(s) for agent %s%s',
              affected.length, agentId, modelChanged ? ' (model changed, sessions cleared)' : '',
            )
          }

          const update = JSON.stringify({
            payload: {
              type: 'editComplete',
              name: draft.name,
              existingAgents: listExistingForPicker(session.sourceChatId),
              version: agentSetup.getAgentSetupVersion(),
              senderAddr: 'server',
            },
            summary: 'Agent updated',
          })
          await ctx.client.sendWebXDCUpdate(session.msgId, update)
          // Keep the session alive — user stays on the main screen.
        } catch (err) {
          ctx.logf('agent-setup: saveEdit failed: %v', err)
        }
        continue
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
            inheritClaudeMd: agents.inheritClaudeMdForModel(agent.model),
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
        const skipPerms = (payload as { skipPermissions?: boolean }).skipPermissions === true
        const inheritClaudeMd = agents.inheritClaudeMdForModel(draft.model)
        const ownerContactId = await resolveOwner()
        if (!ownerContactId) continue

        const agentId = agents.synthesizeAgentId(draft.name)
        try {
          const newChatId = await ctx.client.createGroup(draft.name)
          await ctx.client.addContactToChat(newChatId, ownerContactId)
          access.addChat(newChatId, ownerContactId)
          const newAgent: agents.AgentDef = { ...draft, id: agentId }
          agents.setSkipPermissions(newAgent, skipPerms)
          // Roll a random orientation once at creation so same-model agents
          // are visually differentiable. Edits can override via the setup card.
          agents.setIconMirror(newAgent, Math.random() < 0.5)
          agents.saveAgent(newAgent)
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
