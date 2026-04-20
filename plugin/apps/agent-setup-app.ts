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
import * as models from '../models.js'
import * as bindings from '../bindings.js'
import * as access from '../access.js'
import * as resume from '../resume.js'
import * as templates from '../templates.js'
import { decideCleanup, CONTACT_SELF } from '../cleanup.js'
import { ALL_BUILTIN_TOOLS, BUILTIN_TOOL_DESCRIPTIONS } from '../dispatcher/subagent-process.js'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

function availableToolsPayload(ctx: AppContext) {
  return {
    availableBuiltinTools: ALL_BUILTIN_TOOLS.map(name => ({
      name,
      description: BUILTIN_TOOL_DESCRIPTIONS[name] ?? '',
    })),
    availableMcpServers: ctx.getAvailableMcpServers(),
    connectedMcpServers: ctx.getConnectedMcpServers(),
  }
}

/**
 * Snapshot the template library for the init payload. Each template is
 * marked `available: true` when every MCP server it requires is currently
 * connected — the setup card shows unavailable templates greyed out with
 * the missing service listed.
 */
function templatesPayload(ctx: AppContext): Array<{
  id: string
  name: string
  archetype: string
  icon: string
  glyph: string
  description: string
  model: string
  requiresMcpServers: string[]
  available: boolean
}> {
  const connected = new Set(ctx.getConnectedMcpServers())
  return templates.listTemplates().map(t => {
    const required = t.requires.mcpServers ?? []
    const available = required.every(s => connected.has(s))
    return {
      id: t.id,
      name: t.name,
      archetype: t.archetype,
      icon: t.icon,
      glyph: t.glyph,
      description: t.description,
      model: t.model,
      requiresMcpServers: required,
      available,
    }
  })
}

interface Session {
  msgId: number
  sourceChatId: number
  lastSerial?: number
  needsSerialSeed?: boolean
}

/**
 * Row list for the "Send chat to terminal" picker. One row per paired
 * binding in the access list. Metadata sourced at call time — the
 * handler re-runs every time the pane is opened.
 *
 * `ctx` takes function deps rather than the full AppContext so the
 * helper is trivially unit-testable without a live DC connection.
 */
export interface TeleportOutListCtx {
  jobCountForChat(chatId: number): number
  sessionLive(sessionPath: string): boolean
  chatNameForId(chatId: number): string | null
}

export interface TeleportOutChat {
  chatId: number
  chatName: string
  agentId: string | null
  agentName: string | null
  lastActiveMs: number | null
  jobCount: number
  isTrusted: boolean
  isLive: boolean
  sessionId: string | null
  workingDir: string | null
}

export function buildTeleportOutList(ctx: TeleportOutListCtx): TeleportOutChat[] {
  const rows: TeleportOutChat[] = []
  for (const b of bindings.listBindings()) {
    if (!access.isAllowed(b.chatId)) continue
    const agent = b.agentId ? agents.getAgent(b.agentId) : null
    const chatName = ctx.chatNameForId(b.chatId) ?? `Chat ${b.chatId}`
    const jobCount = ctx.jobCountForChat(b.chatId)
    let isLive = false
    if (b.sessionId && b.workingDir) {
      const hash = resume.projectHashForCwd(b.workingDir)
      const path = join(homedir(), '.claude', 'projects', hash, `${b.sessionId}.jsonl`)
      isLive = ctx.sessionLive(path)
    }
    rows.push({
      chatId: b.chatId,
      chatName,
      agentId: b.agentId ?? null,
      agentName: agent?.name ?? null,
      lastActiveMs: null,
      jobCount,
      isTrusted: !!agent && agents.getSkipPermissions(agent) === true,
      isLive,
      sessionId: b.sessionId ?? null,
      workingDir: b.workingDir ?? null,
    })
  }
  rows.sort((a, b) => (b.lastActiveMs ?? 0) - (a.lastActiveMs ?? 0) || a.chatId - b.chatId)
  return rows
}

// Per-chat msgId pointer: "has this chat seen the setup card yet, and if so,
// which msgId?" First dc_open_agent_settings call sends a new xdc; later calls
// send a status update to the same msgId so the card returns to the top via
// the info notification. No flow state lives here — the card always opens on
// home.
//
// Persisted to disk so `bun server.ts` restarts don't orphan existing cards
// (which would silently drop user interactions — every sent update arrives
// at onWebXDCUpdate with a msgId the central registry doesn't know about).
const sessions = new Map<number, Session>()

const SESSIONS_FILE = join(homedir(), '.claude', 'channels', 'deltachat', 'agent-setup-sessions.json')

function persistSessions(): void {
  try {
    mkdirSync(join(homedir(), '.claude', 'channels', 'deltachat'), { recursive: true })
    const array = Array.from(sessions.values())
    writeFileSync(SESSIONS_FILE, JSON.stringify(array, null, 2))
  } catch {
    // Non-fatal: worst case, next restart orphans these cards. Log via ctx
    // isn't available here; silent swallow is acceptable since the caller
    // already logged the successful send.
  }
}

function loadSessions(): Session[] {
  if (!existsSync(SESSIONS_FILE)) return []
  try {
    const raw = readFileSync(SESSIONS_FILE, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const out: Session[] = []
    for (const entry of parsed) {
      if (
        entry && typeof entry === 'object' &&
        typeof (entry as Session).msgId === 'number' &&
        typeof (entry as Session).sourceChatId === 'number'
      ) {
        out.push({
          msgId: (entry as Session).msgId,
          sourceChatId: (entry as Session).sourceChatId,
          lastSerial: typeof (entry as any).lastSerial === 'number' ? (entry as any).lastSerial : undefined,
        })
      }
    }
    return out
  } catch {
    return []
  }
}

/** Baseline draft for a fresh "create agent" form. The client populates
 *  these values when the user navigates to the create screen from home. */
function blankDraft(): agents.DraftAgent {
  return {
    name: 'New agent',
    model: agents.DEFAULT_MODEL,
    description: '',
    system: agents.DEFAULT_SYSTEM_PROMPT,
    tools: [],
  }
}

/** Summarize agents for the picker screen. */
async function listExistingForPicker(sourceChatId: number): Promise<Array<{ id: string; name: string; model: string; archetype: string; icon: string; glyph: string; tier: string; isTrusted: boolean; iconDataUri: string; bindingCount: number; isCurrentAgent: boolean; isUndeletable: boolean }>> {
  const { renderAgentBadge } = await import('../agent-icon-render.js')
  const sourceBinding = bindings.getBinding(sourceChatId)
  const { readFileSync } = await import('node:fs')
  return Promise.all(agents.listAgents().map(async a => {
    const archetype = agents.getArchetype(a) as 'role' | 'utility' | 'project'
    const tier = models.tierForModel(a.model)
    const trust = agents.getSkipPermissions(a)
    const glyph = agents.glyphForAgent(a)
    let iconDataUri = ''
    try {
      const pngPath = await renderAgentBadge({ archetype, modelFamily: tier, trust, glyph })
      iconDataUri = `data:image/png;base64,${readFileSync(pngPath).toString('base64')}`
    } catch {
      /* fall back to empty — client renders a placeholder */
    }
    return {
      id: a.id,
      name: a.name,
      model: a.model,
      archetype,
      icon: agents.iconForAgent(a),
      glyph,
      tier,
      isTrusted: trust,
      iconDataUri,
      bindingCount: bindings.countByAgentId(a.id),
      isCurrentAgent: sourceBinding?.agentId === a.id,
      isUndeletable: agents.isUndeletableAgent(a.id),
    }
  }))
}

/**
 * Proactively detect dead chats (owner left or chat deleted locally)
 * that the event-based cleanup missed. Uses getFullChat to check
 * contactIds (current members) and pastContactIds (former members).
 *
 * A chat is swept if:
 *   1. The bot is no longer a member (bot-removed), OR
 *   2. The bot is the only current member (bot-alone), OR
 *   3. The chat can no longer send (canSend=false).
 *
 * Called before building the manage-screen payload so binding counts
 * are accurate.
 */
async function sweepDeadChats(ctx: AppContext): Promise<void> {
  for (const b of bindings.listBindings()) {
    if (!access.isAllowed(b.chatId)) continue
    try {
      const fc = await ctx.client.getFullChat(b.chatId)
      const decision = decideCleanup('ChatModified', fc.contactIds)
      if (decision.cleanup) {
        bindings.deleteBinding(b.chatId)
        access.removeChat(b.chatId)
        ctx.logf('agent-setup: swept dead chat %d (%s) contacts=%v past=%v',
          b.chatId, decision.reason, fc.contactIds, fc.pastContactIds)
        continue
      }
      if (!fc.canSend) {
        bindings.deleteBinding(b.chatId)
        access.removeChat(b.chatId)
        ctx.logf('agent-setup: swept unsendable chat %d canSend=false', b.chatId)
        continue
      }
      ctx.logf('agent-setup: sweep kept chat %d agent=%s contacts=%v past=%v canSend=%v selfInGroup=%v',
        b.chatId, b.agentId ?? 'none', fc.contactIds, fc.pastContactIds, fc.canSend, fc.selfInGroup)
    } catch (err) {
      ctx.logf('agent-setup: sweep check failed chat %d: %v', b.chatId, err)
    }
  }
}

async function sendInit(
  ctx: AppContext,
  app: WebXDCApp,
  sourceChatId: number,
): Promise<Session> {
  await sweepDeadChats(ctx)
  const existing = sessions.get(sourceChatId)
  const draft = blankDraft()
  const payload = {
    type: 'init' as const,
    version: agentSetup.getAgentSetupVersion(),
    draft: {
      ...draft,
      skipPermissions: agents.getSkipPermissions(draft as agents.AgentDef),
      iconMirror: agents.getIconMirror(draft as agents.AgentDef),
    },
    existingAgents: await listExistingForPicker(sourceChatId),
    senderAddr: 'server',
    templates: templatesPayload(ctx),
    availableModels: models.MODELS.map(m => ({ id: m.id, label: m.label, tier: m.tier })),
    defaultModel: models.DEFAULT_MODEL,
    ...availableToolsPayload(ctx),
  }
  const update = JSON.stringify({
    payload,
    summary: 'Agent setup',
    info: 'Tap to open agent settings',
    href: 'index.html',
  })

  if (existing) {
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
  const session: Session = { msgId, sourceChatId }
  sessions.set(sourceChatId, session)
  persistSessions()
  ctx.registerWebXDCMsg(msgId, app, sourceChatId)
  ctx.logf('agent-setup: sent app (msg %d) to chat %d', msgId, sourceChatId)
  return session
}

/**
 * Public entry point for other apps (e.g. permissions) that want to
 * summon the agent settings card into a chat. Equivalent to the subagent
 * calling `dc_open_agent_settings` but callable from the dispatcher side.
 */
export async function summonAgentSettings(ctx: AppContext, chatId: number): Promise<void> {
  await sendInit(ctx, agentSetupApp, chatId)
}

/** Minimal context for decorating agent chats (icon + welcome). */
export interface DecorateContext {
  client: Pick<import('../dc-client.js').DCClient, 'setChatProfileImage' | 'send'>
  logf: (format: string, ...args: unknown[]) => void
}

/**
 * Render the agent's badge PNG and install it as the chat profile image.
 * Inputs are derived from the agent's archetype, model family, trust
 * flag (skip-permissions), and resolved glyph (explicit override if in
 * the archetype's palette, otherwise the archetype default).
 */
export async function setAgentIcon(
  ctx: DecorateContext,
  chatId: number,
  agent: agents.AgentDef,
): Promise<void> {
  const { renderAgentBadge } = await import('../agent-icon-render.js')
  const archetype = agents.getArchetype(agent)
  const modelFamily = models.tierForModel(agent.model)
  const trust = agents.getSkipPermissions(agent)
  const glyph = agents.glyphForAgent(agent)
  const iconPath = await renderAgentBadge({ archetype, modelFamily, trust, glyph })
  await ctx.client.setChatProfileImage(chatId, iconPath)
  ctx.logf(
    'agent-setup: set agent badge %s/%s/%s/%s for chat %d',
    archetype, modelFamily, trust ? 'trust' : 'plain', glyph, chatId,
  )
}

/** Apply icon + intro message after a chat has been bound to an agent. */
export async function decorateAgentChat(
  ctx: DecorateContext,
  chatId: number,
  agent: agents.AgentDef,
): Promise<void> {
  try {
    await setAgentIcon(ctx, chatId, agent)
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

  start(ctx: AppContext): void {
    const saved = loadSessions()
    for (const s of saved) {
      if (s.lastSerial == null) s.needsSerialSeed = true
      sessions.set(s.sourceChatId, s)
      ctx.registerWebXDCMsg(s.msgId, agentSetupApp, s.sourceChatId, s.lastSerial)
    }
    if (saved.length > 0) {
      ctx.logf('agent-setup: rehydrated %d session(s) from disk (%d need serial seed)',
        saved.length, saved.filter(s => s.needsSerialSeed).length)
    }
  },

  instructions:
    'AGENT SETTINGS APP:\n' +
    '1. The agent settings app is a self-contained UI where the user manages ' +
    'their agents, starts new chats, and resumes terminal sessions. Call ' +
    'dc_open_agent_settings to surface it whenever the user mentions ANY of: ' +
    'creating a new agent, starting a new chat, editing/deleting/managing ' +
    'agents, "agent app", "agent card", "settings app", "send me the app", ' +
    '"change the model", "change my prompt", "edit this agent", "teleport", ' +
    '"import terminal session", "resume a session". The app always opens on ' +
    'its home screen — the user picks what they want to do from there.\n' +
    '2. Do NOT build or send agent-setup.xdc yourself via Bash/dc_send_webxdc. ' +
    'Do NOT read agent-setup.ts or agent-setup-app.ts. Do NOT read or edit ' +
    'agent YAML files. dc_open_agent_settings is the only supported path.\n' +
    '3. Do NOT offer to change agent settings through conversation — send ' +
    'the app instead.',

  tools(): ToolDef[] {
    return [
      {
        name: 'dc_open_agent_settings',
        description:
          'Surface the Agent settings app in the user\'s chat. The app always ' +
          'opens on a home screen where the user chooses what to do: start a ' +
          'new chat with an agent, manage (edit / delete / export) existing ' +
          'agents, or resume a terminal session. Call this whenever the user ' +
          'asks about agents, new chats, resuming a terminal session, or anything ' +
          'else that belongs in the settings UI — the app handles all of it.',
        inputSchema: {
          type: 'object',
          properties: {
            source_chat_id: {
              type: 'string',
              description: 'The chat the user is messaging from (where to surface the settings app).',
            },
          },
          required: ['source_chat_id'],
        },
      },
    ]
  },

  async callTool(name: string, args: Record<string, unknown>, ctx: AppContext): Promise<ToolResult | null> {
    if (name !== 'dc_open_agent_settings') return null

    const sourceChatId = Number(args.source_chat_id as string)
    if (!sourceChatId || Number.isNaN(sourceChatId)) {
      return { content: [{ type: 'text', text: 'dc_open_agent_settings: invalid source_chat_id' }], isError: true }
    }
    if (!ctx.isAllowed(sourceChatId)) {
      return { content: [{ type: 'text', text: `dc_open_agent_settings: chat ${sourceChatId} not allowed` }], isError: true }
    }

    try {
      await sendInit(ctx, agentSetupApp, sourceChatId)
    } catch (err) {
      ctx.logf('agent-setup: send failed: %v', err)
      return { content: [{ type: 'text', text: `dc_open_agent_settings: send failed: ${(err as Error).message}` }], isError: true }
    }

    return {
      content: [{
        type: 'text',
        text: `Agent settings app surfaced in chat ${sourceChatId}.`,
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

    // Migration guard: sessions loaded from disk without a persisted
    // lastSerial (pre-fix) would replay every old create/bind action on
    // the first update batch. Instead, seed the serial from the batch
    // and skip processing — the next batch will be new updates only.
    if (session.needsSerialSeed) {
      const maxSerial = updates.reduce((m, u) => Math.max(m, u.serial ?? 0), 0)
      session.lastSerial = maxSerial
      delete session.needsSerialSeed
      persistSessions()
      ctx.logf('agent-setup: seeded serial %d for chat %d (migration)', maxSerial, session.sourceChatId)
      return
    }

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
          await sendInit(ctx, agentSetupApp, session.sourceChatId)
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
          archetype: agents.getArchetype(agent),
          icon: agents.iconForAgent(agent),
          explicitIcon: agents.getExplicitIcon(agent),
          glyph: agents.glyphForAgent(agent),
          allowedBuiltinTools: agent.allowedBuiltinTools ?? null,
          allowedMcpServers: agent.allowedMcpServers ?? null,
        }
        try {
          const update = JSON.stringify({
            payload: {
              type: 'edit',
              draft: editDraft,
              version: agentSetup.getAgentSetupVersion(),
              senderAddr: 'server',
              availableModels: models.MODELS.map(m => ({ id: m.id, label: m.label, tier: m.tier })),
              defaultModel: models.DEFAULT_MODEL,
              ...availableToolsPayload(ctx),
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
        if (agents.isUndeletableAgent(agentId)) {
          ctx.logf('agent-setup: refusing to delete built-in default agent %s', agentId)
          continue
        }
        const agent = agents.getAgent(agentId)
        if (!agent) {
          ctx.logf('agent-setup: delete requested agent %s not found', agentId)
          continue
        }
        try {
          // Rebind affected chats to the default agent and refresh their
          // profile icon so the chat avatar reflects the new assistant
          // immediately (don't wait for the next message / auto-repair).
          const affected = bindings.listBindings().filter(b => b.agentId === agentId)
          if (affected.length > 0) {
            const defaultAgent = agents.ensureDefaultAgent()
            await Promise.all(
              affected.map(b =>
                ctx.client.send(
                  b.chatId,
                  `The "${agent.name}" agent was deleted. This chat will use the "${defaultAgent.name}" default assistant.`,
                ).catch(() => {}),
              ),
            )
            await Promise.all(
              affected.map(async b => {
                await ctx.evictSubagent(b.chatId)
                bindings.saveBinding({
                  chatId: b.chatId,
                  agentId: defaultAgent.id,
                  inheritClaudeMd: agents.inheritClaudeMdForModel(defaultAgent.model),
                  createdAt: new Date().toISOString(),
                })
                bindings.clearSessionId(b.chatId)
                try {
                  await setAgentIcon({ client: ctx.client, logf: ctx.logf }, b.chatId, defaultAgent)
                } catch (err) {
                  ctx.logf('agent-setup: icon refresh failed for chat %d: %v', b.chatId, err)
                }
              }),
            )
            ctx.logf('agent-setup: rebound %d chat(s) from agent %s to default', affected.length, agentId)
          }

          agents.deleteAgent(agentId)
          ctx.logf('agent-setup: deleted agent %s', agentId)
          const update = JSON.stringify({
            payload: {
              type: 'deleted',
              name: agent.name,
              existingAgents: await listExistingForPicker(session.sourceChatId),
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

      if (payload.type === 'resume_list_request') {
        const requestId = typeof (payload as { requestId?: unknown }).requestId === 'number'
          ? (payload as { requestId: number }).requestId : 0
        const candidates = resume.listResumeCandidates()
        try {
          const update = JSON.stringify({
            payload: {
              type: 'resume_list',
              requestId,
              candidates,
              version: agentSetup.getAgentSetupVersion(),
              senderAddr: 'server',
            },
            summary: 'Session list',
          })
          await ctx.client.sendWebXDCUpdate(session.msgId, update)
        } catch (err) {
          ctx.logf('agent-setup: resume_list send failed: %v', err)
        }
        continue
      }

      if (payload.type === 'teleport_out_commit') {
        const requestId = typeof (payload as { requestId?: unknown }).requestId === 'number'
          ? (payload as { requestId: number }).requestId : 0
        const chatId = typeof (payload as { chatId?: unknown }).chatId === 'number'
          ? (payload as { chatId: number }).chatId : NaN
        const jobDisposition = (payload as { jobDisposition?: unknown }).jobDisposition

        const sendErr = async (step: string, message: string) => {
          await ctx.client.sendWebXDCUpdate(session.msgId, JSON.stringify({
            payload: {
              type: 'teleport_out_error', requestId, step, message,
              version: agentSetup.getAgentSetupVersion(), senderAddr: 'server',
            },
            summary: 'Teleport-out error',
          })).catch(() => {})
        }
        const emit = async (step: string, status: 'start' | 'done', detail?: string) => {
          await ctx.client.sendWebXDCUpdate(session.msgId, JSON.stringify({
            payload: {
              type: 'teleport_out_progress', requestId, step, status,
              detail: detail ?? null,
              version: agentSetup.getAgentSetupVersion(), senderAddr: 'server',
            },
            summary: `Teleport-out: ${step} ${status}`,
          })).catch(() => {})
        }

        if (!Number.isFinite(chatId) || !access.isAllowed(chatId)) {
          await sendErr('validate', 'Invalid chat')
          continue
        }

        try {
          let chatName: string | undefined
          try { chatName = await ctx.client.getChatName(chatId) || undefined } catch { /* best effort */ }

          // Build command FIRST — if binding is bad, bail out before mutating.
          const cmdResult = resume.buildResumeCommand(chatId, { chatName })
          if ('error' in cmdResult) {
            await sendErr('build-command', cmdResult.error)
            continue
          }

          await emit('evict', 'start')
          await ctx.subagentCache.evictChat(chatId).catch(() => {})
          await emit('evict', 'done')

          await emit('jobs', 'start')
          if (jobDisposition && typeof jobDisposition === 'object' &&
              (jobDisposition as { kind?: string }).kind === 'move' &&
              typeof (jobDisposition as { toChatId?: unknown }).toChatId === 'number') {
            const to = (jobDisposition as { toChatId: number }).toChatId
            const moved = ctx.scheduleStore.moveForChat(chatId, to)
            await emit('jobs', 'done', `moved ${moved} jobs to chat ${to}`)
          } else {
            const deleted = ctx.scheduleStore.deleteForChat(chatId)
            await emit('jobs', 'done', `deleted ${deleted} jobs`)
          }

          await emit('state', 'start')
          await ctx.cleanupChatState(chatId, { chatAction: 'leave', reason: 'teleport-out-gui' })
          await emit('state', 'done')

          await emit('command', 'start')
          try {
            await ctx.client.send(chatId, '```\n' + cmdResult.command + '\n```')
          } catch (err) {
            ctx.logf('agent-setup: teleport-out command send failed: %v', err)
          }
          await emit('command', 'done')

          await ctx.client.sendWebXDCUpdate(session.msgId, JSON.stringify({
            payload: {
              type: 'teleport_out_done',
              requestId,
              command: cmdResult.command,
              sessionId: cmdResult.sessionId,
              chatName: chatName ?? null,
              version: agentSetup.getAgentSetupVersion(),
              senderAddr: 'server',
            },
            summary: 'Teleport-out done',
          })).catch(() => {})
        } catch (err) {
          ctx.logf('agent-setup: teleport_out_commit failed: %v', err)
          await sendErr('unexpected', (err as Error).message || 'unexpected error')
        }
        continue
      }

      if (payload.type === 'teleport_out_list_request') {
        const requestId = typeof (payload as { requestId?: unknown }).requestId === 'number'
          ? (payload as { requestId: number }).requestId : 0
        try {
          const { spawnSync } = await import('node:child_process')
          const liveChecker = (p: string) => {
            try {
              const res = spawnSync('fuser', [p], { timeout: 3000, stdio: 'pipe' })
              return res.status === 0
            } catch { return false }
          }
          const list = buildTeleportOutList({
            jobCountForChat: (cid) => ctx.scheduleStore.countForChat(cid),
            sessionLive: liveChecker,
            chatNameForId: () => null,
          })
          for (const row of list) {
            try {
              const name = await ctx.client.getChatName(row.chatId)
              if (name) row.chatName = name
            } catch { /* keep fallback */ }
          }
          await ctx.client.sendWebXDCUpdate(session.msgId, JSON.stringify({
            payload: {
              type: 'teleport_out_list',
              requestId,
              chats: list,
              version: agentSetup.getAgentSetupVersion(),
              senderAddr: 'server',
            },
            summary: 'Teleport-out list',
          }))
        } catch (err) {
          ctx.logf('agent-setup: teleport_out_list_request failed: %v', err)
        }
        continue
      }

      if (payload.type === 'paired_list_request') {
        const requestId = typeof (payload as { requestId?: unknown }).requestId === 'number'
          ? (payload as { requestId: number }).requestId : 0
        try {
          const devices = access.listPaired()
          const rows: Array<{
            contactId: number
            displayName: string
            address: string
            isVerified: boolean
            chatCount: number
            pairedAtMs: number
            isSelf: boolean
          }> = []
          for (const d of devices) {
            let displayName = `Contact ${d.contactId}`
            let address = ''
            let isVerified = false
            try {
              const contact = await ctx.client.getContact(d.contactId)
              if (contact) {
                displayName = contact.displayName || contact.name || displayName
                address = contact.address ?? ''
                isVerified = !!contact.isVerified
              }
            } catch (err) {
              ctx.logf('agent-setup: paired_list getContact failed for %d: %v', d.contactId, err)
            }
            rows.push({
              contactId: d.contactId,
              displayName,
              address,
              isVerified,
              chatCount: d.chatIds.length,
              pairedAtMs: d.pairedAtMs,
              isSelf: d.chatIds.includes(session.sourceChatId),
            })
          }
          await ctx.client.sendWebXDCUpdate(session.msgId, JSON.stringify({
            payload: {
              type: 'paired_list',
              requestId,
              devices: rows,
              version: agentSetup.getAgentSetupVersion(),
              senderAddr: 'server',
            },
            summary: 'Paired devices',
          }))
        } catch (err) {
          ctx.logf('agent-setup: paired_list_request failed: %v', err)
        }
        continue
      }

      if (payload.type === 'unpair_commit') {
        const requestId = typeof (payload as { requestId?: unknown }).requestId === 'number'
          ? (payload as { requestId: number }).requestId : 0
        const contactId = typeof (payload as { contactId?: unknown }).contactId === 'number'
          ? (payload as { contactId: number }).contactId : NaN
        const rawMode = (payload as { mode?: unknown }).mode
        const mode: 'freeze' | 'delete' = rawMode === 'delete' ? 'delete' : 'freeze'

        const sendErr = async (message: string) => {
          await ctx.client.sendWebXDCUpdate(session.msgId, JSON.stringify({
            payload: {
              type: 'unpair_error', requestId, message,
              version: agentSetup.getAgentSetupVersion(), senderAddr: 'server',
            },
            summary: 'Unpair error',
          })).catch(() => {})
        }

        if (!Number.isFinite(contactId) || contactId < 1) {
          await sendErr('Invalid contact')
          continue
        }

        const chatIds = access.chatsForOwner(contactId)
        if (chatIds.length === 0) {
          await sendErr('No paired chats for this contact')
          continue
        }

        // Send the "done" response first so the card can update its UI before
        // cleanup tears down the chats — if the source chat is among those
        // owned by this contact, the app will stop receiving updates once
        // `cleanupChatState` runs against it.
        try {
          const devicesAfter = access.listPaired().filter(d => d.contactId !== contactId)
          await ctx.client.sendWebXDCUpdate(session.msgId, JSON.stringify({
            payload: {
              type: 'unpair_done',
              requestId,
              contactId,
              mode,
              chatCount: chatIds.length,
              remainingDevices: devicesAfter.length,
              version: agentSetup.getAgentSetupVersion(),
              senderAddr: 'server',
            },
            summary: 'Unpaired',
          }))
        } catch (err) {
          ctx.logf('agent-setup: unpair_done send failed: %v', err)
        }

        // Clean up each owned chat. Post a farewell message before leaving so
        // the user sees context in the frozen chat; skip it on delete since
        // the chat disappears.
        const farewell = mode === 'freeze'
          ? 'You\'ve been unpaired from this Claude bot. This chat is now read-only — your history is preserved but no new messages will be processed.'
          : null
        const chatAction: 'delete' | 'leave' = mode === 'delete' ? 'delete' : 'leave'
        // Process non-source chats first, then the source chat last, so the
        // user's WebXDC card stays responsive until the moment its host chat
        // is torn down.
        const ordered = chatIds.slice().sort((a, b) => {
          if (a === session.sourceChatId) return 1
          if (b === session.sourceChatId) return -1
          return a - b
        })
        for (const cid of ordered) {
          if (farewell) {
            try { await ctx.client.send(cid, farewell) } catch (err) {
              ctx.logf('agent-setup: unpair farewell send failed chat=%d: %v', cid, err)
            }
          }
          try {
            await ctx.cleanupChatState(cid, { chatAction, reason: `unpair-${mode}` })
          } catch (err) {
            ctx.logf('agent-setup: unpair cleanup failed chat=%d: %v', cid, err)
          }
        }
        ctx.logf('agent-setup: unpaired contact %d (%s, %d chat(s))', contactId, mode, chatIds.length)
        continue
      }

      if (payload.type === 'resume_attach') {
        const requestId = typeof (payload as { requestId?: unknown }).requestId === 'number'
          ? (payload as { requestId: number }).requestId : 0
        const sessionId = typeof (payload as { sessionId?: unknown }).sessionId === 'string'
          ? (payload as { sessionId: string }).sessionId : ''
        if (!sessionId) {
          ctx.logf('agent-setup: resume_attach missing sessionId')
          continue
        }
        try {
          const ownerContactId = await resolveOwner()
          if (!ownerContactId) continue

          if (resume.isSessionLive(sessionId)) {
            ctx.logf('agent-setup: session %s appears active in terminal, warning user', sessionId)
            await ctx.client.sendWebXDCUpdate(session.msgId, JSON.stringify({
              payload: {
                type: 'resume_attach_err',
                requestId,
                message: 'This session appears to be active in a terminal. Close it first, then try again.',
                version: agentSetup.getAgentSetupVersion(),
                senderAddr: 'server',
              },
              summary: 'Session active',
            }))
            continue
          }
          const candidates = resume.listResumeCandidates()
          const candidate = candidates.find(c => c.sessionId === sessionId)

          const sourceBinding = bindings.getBinding(session.sourceChatId)
          const agentId = sourceBinding?.agentId ?? 'claude-code'
          const agent = agents.getAgent(agentId)

          // Use terminal session name for the DC chat if available.
          const initialName = candidate?.sessionName || 'Resumed session'
          const newChatId = await ctx.client.createGroup(initialName)
          await ctx.client.addContactToChat(newChatId, ownerContactId)
          access.addChat(newChatId, ownerContactId)

          bindings.bindAgent(newChatId, agentId, {
            inheritClaudeMd: agent ? agents.inheritClaudeMdForModel(agent.model) : true,
          })
          await resume.attachSessionToChat(newChatId, sessionId)
          if (agent) await decorateAgentChat(ctx, newChatId, agent)

          ctx.logf('agent-setup: resume-import created chat %d with session %s for owner %d', newChatId, sessionId, ownerContactId)

          // Send the success modal ASAP — chat, binding, and file are
          // all in place. The LLM summary + autorename below can take
          // 10–30 s and the user doesn't need to wait in front of a
          // "disabled button, nothing happening" UI for that.
          const update = JSON.stringify({
            payload: {
              type: 'resume_attach_ok',
              requestId,
              sessionId,
              chatId: newChatId,
              chatName: initialName,
              version: agentSetup.getAgentSetupVersion(),
              senderAddr: 'server',
            },
            summary: 'Attached',
          })
          await ctx.client.sendWebXDCUpdate(session.msgId, update)

          // Background: dispatch a summary turn into the new chat so the
          // user sees context; for sessions with no terminal name, also
          // rename the chat once the LLM responds. Fire-and-forget —
          // errors surface only to the log.
          const summaryPrompt =
            '[system] This session was just resumed from a terminal into this new Delta Chat. ' +
            'Briefly summarize what we were working on (2-3 sentences), then on a new line write ' +
            'CHAT_NAME: followed by a short name (3-5 words) for this chat based on the recent work.'
          const fallback = 'Terminal session imported. Send a message to continue where you left off.'

          if (ctx.dispatchAndCollect) {
            ctx.dispatchAndCollect(newChatId, summaryPrompt).then(resp => {
              if (!candidate?.sessionName) {
                const nameMatch = resp.match(/CHAT_NAME:\s*(.+)/i)
                if (nameMatch) {
                  const chatName = nameMatch[1].trim().slice(0, 50)
                  return ctx.client.setChatName(newChatId, chatName)
                }
              }
            }).catch(err => {
              ctx.logf('agent-setup: resume-import summary dispatch failed: %v', err)
              ctx.client.send(newChatId, fallback).catch(() => {})
            })
          } else {
            await ctx.client.send(newChatId, fallback)
          }
          // Session stays alive — the user may want to import another
          // session, create an agent, or manage existing ones from this
          // same card. The home screen is always reachable.
        } catch (err) {
          const msg = (err as Error).message || 'attach failed'
          ctx.logf('agent-setup: resume_attach failed: %v', err)
          try {
            await ctx.client.sendWebXDCUpdate(session.msgId, JSON.stringify({
              payload: {
                type: 'resume_attach_err',
                requestId,
                message: msg,
                version: agentSetup.getAgentSetupVersion(),
                senderAddr: 'server',
              },
              summary: 'Attach failed',
            }))
          } catch (sendErr) {
            ctx.logf('agent-setup: resume_attach_err send failed: %v', sendErr)
          }
        }
        continue
      }

      if (payload.type === 'instantiateTemplate') {
        const templateId = typeof (payload as { templateId?: unknown }).templateId === 'string'
          ? (payload as { templateId: string }).templateId : ''
        if (!templateId) {
          ctx.logf('agent-setup: instantiateTemplate missing templateId')
          continue
        }
        const draft = templates.instantiate(templateId)
        if (!draft) {
          ctx.logf('agent-setup: template %s not found', templateId)
          continue
        }
        const ownerContactId = await resolveOwner()
        if (!ownerContactId) continue

        // Synthesize a fresh id so multiple instantiations of the same
        // template don't collide (the template yaml uses a fixed id).
        const newAgentId = agents.synthesizeAgentId(draft.name)
        try {
          const newChatId = await ctx.client.createGroup(draft.name)
          await ctx.client.addContactToChat(newChatId, ownerContactId)
          access.addChat(newChatId, ownerContactId)
          const newAgent: agents.AgentDef = { ...draft, id: newAgentId }
          // Roll a random orientation so same-model agents are visually
          // differentiable (matches `create` path).
          agents.setIconMirror(newAgent, Math.random() < 0.5)
          agents.saveAgent(newAgent)
          bindings.bindAgent(newChatId, newAgentId, {
            inheritClaudeMd: agents.inheritClaudeMdForModel(newAgent.model),
          })
          const savedAgent = agents.getAgent(newAgentId)
          if (savedAgent) await decorateAgentChat(ctx, newChatId, savedAgent)
          ctx.logf(
            'agent-setup: instantiated template %s as agent %s for chat %d (owner %d)',
            templateId, newAgentId, newChatId, ownerContactId,
          )

          const update = JSON.stringify({
            payload: { type: 'created', chatId: newChatId, name: draft.name },
            summary: 'Agent created',
          })
          await ctx.client.sendWebXDCUpdate(session.msgId, update)
          // Session stays alive — user may keep using the settings card.
        } catch (err) {
          ctx.logf('agent-setup: instantiateTemplate failed: %v', err)
          try { agents.deleteAgent(newAgentId) } catch {}
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
        const rawArchetype = (payload as { archetype?: unknown }).archetype
        const archetype = (typeof rawArchetype === 'string' && (agents.ARCHETYPES as readonly string[]).includes(rawArchetype))
          ? rawArchetype as agents.Archetype : null
        const allowedBuiltinTools = (payload as { allowedBuiltinTools?: string[] | null }).allowedBuiltinTools ?? undefined
        const allowedMcpServers = (payload as { allowedMcpServers?: string[] | null }).allowedMcpServers ?? undefined
        // Snapshot the pre-edit state BEFORE mutating metadata below. We
        // must clone metadata because `updated` shares the object otherwise,
        // and the setters mutate in place — which would make the "changed"
        // checks below always return false.
        const prevModel = agent.model
        const prevSystem = agent.system
        const prevSkip = agents.getSkipPermissions(agent)
        const prevMirror = agents.getIconMirror(agent)
        const prevArchetype = agents.getArchetype(agent)
        const prevExplicitIcon = agents.getExplicitIcon(agent)
        try {
          // Preserve existing metadata (e.g. x-dc-createdAt) across edits, then
          // apply the new skipPermissions / iconMirror flags. Clone to avoid
          // aliasing the original `agent.metadata` reference.
          const updated: agents.AgentDef = {
            ...draft,
            id: agentId,
            metadata: agent.metadata ? { ...agent.metadata } : undefined,
            allowedBuiltinTools,
            allowedMcpServers,
          }
          agents.setSkipPermissions(updated, skipPerms)
          agents.setIconMirror(updated, iconMirror)
          if (archetype) agents.setArchetype(updated, archetype)
          const rawIcon = (payload as { icon?: unknown }).icon
          if (typeof rawIcon === 'string') {
            // Trim whitespace; empty string clears the explicit icon.
            agents.setIcon(updated, rawIcon.trim() || null)
          }
          agents.saveAgent(updated)
          ctx.logf(
            'agent-setup: edited agent %s (model=%s skip=%s mirror=%s archetype=%s)',
            agentId, draft.model, skipPerms, iconMirror, archetype ?? 'unchanged',
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
          const archetypeChanged = archetype != null && prevArchetype !== archetype
          const newExplicitIcon = agents.getExplicitIcon(updated)
          const explicitIconChanged = prevExplicitIcon !== newExplicitIcon
          const prevBuiltinTools = JSON.stringify(agent.allowedBuiltinTools ?? null)
          const newBuiltinTools = JSON.stringify(allowedBuiltinTools ?? null)
          const prevMcpServersList = JSON.stringify(agent.allowedMcpServers ?? null)
          const newMcpServersList = JSON.stringify(allowedMcpServers ?? null)
          const toolsChanged = prevBuiltinTools !== newBuiltinTools || prevMcpServersList !== newMcpServersList
          // Restart only for changes that are baked in at subagent spawn
          // time: the model (passed as --model and cached in the session
          // store) and the system prompt (read from disk at spawn). Cosmetic
          // changes (name, icon orientation) and skipPermissions — which the
          // dispatcher re-reads on every hook call — don't need a restart.
          const needsRestart = modelChanged || systemChanged || toolsChanged
          const iconChanged =
            modelChanged || skipPermsChanged || mirrorChanged ||
            archetypeChanged || explicitIconChanged
          const affected = bindings.listBindings().filter(b => b.agentId === agentId)
          const newInherit = agents.inheritClaudeMdForModel(draft.model)

          // Notify affected chats before evicting so the user knows
          // the pause is intentional, not a hang.
          if (needsRestart && affected.length > 0) {
            const restartMsg = modelChanged
              ? `Agent updated. Restarting with new model (${draft.model.replace('claude-', '')})...`
              : toolsChanged
                ? 'Agent updated. Restarting with new tool configuration...'
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
                await setAgentIcon(ctx, b.chatId, updated).catch(err =>
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
              existingAgents: await listExistingForPicker(session.sourceChatId),
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
          // Session stays alive — user may keep using the settings card.
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
        const rawArchetype = (payload as { archetype?: unknown }).archetype
        const archetype = (typeof rawArchetype === 'string' && (agents.ARCHETYPES as readonly string[]).includes(rawArchetype))
          ? rawArchetype as agents.Archetype : null
        const allowedBuiltinTools = (payload as { allowedBuiltinTools?: string[] | null }).allowedBuiltinTools ?? undefined
        const allowedMcpServers = (payload as { allowedMcpServers?: string[] | null }).allowedMcpServers ?? undefined
        const inheritClaudeMd = agents.inheritClaudeMdForModel(draft.model)
        const ownerContactId = await resolveOwner()
        if (!ownerContactId) continue

        const agentId = agents.synthesizeAgentId(draft.name)
        try {
          const newChatId = await ctx.client.createGroup(draft.name)
          await ctx.client.addContactToChat(newChatId, ownerContactId)
          access.addChat(newChatId, ownerContactId)
          const newAgent: agents.AgentDef = { ...draft, id: agentId, allowedBuiltinTools, allowedMcpServers }
          agents.setSkipPermissions(newAgent, skipPerms)
          if (archetype) agents.setArchetype(newAgent, archetype)
          const rawIcon = (payload as { icon?: unknown }).icon
          if (typeof rawIcon === 'string' && rawIcon.trim()) {
            agents.setIcon(newAgent, rawIcon.trim())
          }
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
          // Session stays alive — user may keep using the settings card.
        } catch (err) {
          ctx.logf('agent-setup: create failed: %v', err)
          // Roll back the agent file if it was written but binding failed.
          try { agents.deleteAgent(agentId) } catch {}
        }
      }
    }

    // Persist the high-water serial so a dispatcher restart doesn't
    // replay old create/bind/edit actions and create duplicate chats.
    const maxSerial = updates.reduce((m, u) => Math.max(m, u.serial ?? 0), 0)
    if (session && maxSerial > (session.lastSerial ?? 0)) {
      session.lastSerial = maxSerial
      persistSessions()
    }
  },
}
