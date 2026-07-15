/**
 * Teleport WebXDC app — standalone bespoke card for teleport-out and
 * resume-attach flows. Ported from the four handlers in agent-setup-app.ts
 * and gated by the §6 ControlAuthDeps authorization helper.
 *
 * Authorization note (§6): webXDC senderAddr is app-relayed and spoofable
 * (verified, dc-core 2.53). State-changing handlers MUST gate on
 * isControlCommandAuthorized rather than anything the card payload says.
 * Read-only handlers (list requests) do not need the gate.
 */

import type { WebXDCApp, ToolDef, ToolResult, AppContext } from '../webxdc-app.js'
import type { WebXDCUpdate } from '../dc-client.js'
import * as access from '../access/index.js'
import * as agents from '../agents.js'
import * as resume from '../resume.js'
import * as bindings from '../bindings.js'
import { buildTeleportOutList, markCurrentChat } from '../teleport-core.js'
import { getTeleportVersion, buildTeleportXDC } from '../teleport.js'
import {
  isControlCommandAuthorized,
  type ControlAuthDeps,
} from '../access/webxdc-control-auth.js'
import { decorateAgentChat, resolveAttachAgent } from './agent-setup-app.js'

// ── Module-level state ───────────────────────────────────────────────────

/** Maps msgId → chatId for registered teleport cards. */
const teleportSessions = new Map<number, number>()

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

// ── Exported handlers (unit-testable) ───────────────────────────────────

/**
 * Handler for `teleport_out_commit`. State-changing: evicts the subagent,
 * deletes/moves scheduled jobs, prints the resume command, and calls
 * cleanupChatState. Gated by the injected `auth` callback.
 *
 * @param ctx  AppContext (or a compatible stub for tests).
 * @param msgId  The teleport card's msgId (used to send WebXDC updates back).
 * @param payload  Decoded payload from the card.
 * @param auth  Auth callback; returns {ok:true} or {ok:false, reason}.
 */
export async function handleTeleportOutCommit(
  ctx: AppContext,
  msgId: number,
  payload: { requestId?: unknown; chatId?: unknown; jobDisposition?: unknown },
  auth: () => Promise<{ ok: true } | { ok: false; reason: 'no-owner' | 'needs-confirmation' }>,
): Promise<void> {
  const requestId = typeof payload.requestId === 'number' ? payload.requestId : 0
  const chatId = typeof payload.chatId === 'number' ? payload.chatId : NaN
  const jobDisposition = payload.jobDisposition

  const sendErr = async (step: string, message: string) => {
    await ctx.client.sendWebXDCUpdate(msgId, JSON.stringify({
      payload: {
        type: 'teleport_out_error', requestId, step, message,
        version: getTeleportVersion(), senderAddr: 'server',
      },
      summary: 'Teleport-out error',
    })).catch(() => {})
  }
  const emit = async (step: string, status: 'start' | 'done', detail?: string) => {
    await ctx.client.sendWebXDCUpdate(msgId, JSON.stringify({
      payload: {
        type: 'teleport_out_progress', requestId, step, status,
        detail: detail ?? null,
        version: getTeleportVersion(), senderAddr: 'server',
      },
      summary: `Teleport-out: ${step} ${status}`,
    })).catch(() => {})
  }

  // §6 authorization gate.
  const authResult = await auth()
  if (!authResult.ok) {
    const message = authResult.reason === 'needs-confirmation'
      ? "Teleporting from a group has to come from you directly — say 'teleport this session' in our chat, or open this from your 1:1 with me."
      : 'No owner found for this chat.'
    await sendErr('auth', message)
    return
  }

  if (!Number.isFinite(chatId) || !access.isAllowed(chatId)) {
    await sendErr('validate', 'Invalid chat')
    return
  }

  try {
    let chatName: string | undefined
    try { chatName = await ctx.client.getChatName(chatId) || undefined } catch { /* best effort */ }

    // Build command FIRST — if binding is bad, bail out before mutating.
    const cmdResult = resume.buildResumeCommand(chatId, { chatName })
    if ('error' in cmdResult) {
      await sendErr('build-command', cmdResult.error)
      return
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

    // Deliver the resume command into the chat BEFORE any chat-side
    // teardown, while the bot is still a full member. Previously this
    // ran after cleanupChatState left the group, so the send hit a
    // "not a member of the chat" error and the command was silently
    // lost (the user saw teleport-out "fail").
    await emit('command', 'start')
    try {
      await ctx.client.send(chatId, '```\n' + cmdResult.command + '\n```')
    } catch (err) {
      ctx.logf('teleport: teleport-out command send failed: %v', err)
    }
    await emit('command', 'done')

    // chatAction:'none' — cleanupChatState still removes the binding
    // (the session has moved to the terminal), but the bot does NOT
    // leave the group, so the DC chat stays usable and re-bindable. A
    // hard 'leave' would emit a "You left the group" system message
    // that, on a chatmail account, orphans the chat's read-receipts/
    // status-updates and head-of-line-blocks the SMTP queue for ALL
    // chats. 'leave' is reserved for unpair/delete.
    await emit('state', 'start')
    await ctx.cleanupChatState(chatId, { chatAction: 'none', reason: 'teleport-out-gui' })
    await emit('state', 'done')

    await ctx.client.sendWebXDCUpdate(msgId, JSON.stringify({
      payload: {
        type: 'teleport_out_done',
        requestId,
        command: cmdResult.command,
        sessionId: cmdResult.sessionId,
        chatName: chatName ?? null,
        version: getTeleportVersion(),
        senderAddr: 'server',
      },
      summary: 'Teleport-out done',
    })).catch(() => {})
  } catch (err) {
    ctx.logf('teleport: teleport_out_commit failed: %v', err)
    await sendErr('unexpected', (err as Error).message || 'unexpected error')
  }
}

/**
 * Handler for `resume_attach`. State-changing: creates a new DC group,
 * binds the session, decorates the chat. Gated by the injected `auth`
 * callback.
 */
export async function handleResumeAttach(
  ctx: AppContext,
  msgId: number,
  sourceChatId: number,
  payload: { requestId?: unknown; sessionId?: unknown },
  auth: () => Promise<{ ok: true } | { ok: false; reason: 'no-owner' | 'needs-confirmation' }>,
  // #137: injectable liveness/candidate probes (the real ones shell out to
  // fuser and scan /proc) so the out→attach round trip is a pure-filesystem
  // test. Same pattern buildTeleportOutList already uses.
  deps: {
    sessionLive?: (sessionId: string) => boolean
    listCandidates?: () => ReturnType<typeof resume.listResumeCandidates>
  } = {},
): Promise<void> {
  const sessionLive = deps.sessionLive ?? resume.isSessionLive
  const listCandidates = deps.listCandidates ?? resume.listResumeCandidates
  const requestId = typeof payload.requestId === 'number' ? payload.requestId : 0
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
  if (!sessionId) {
    ctx.logf('teleport: resume_attach missing sessionId')
    return
  }

  // §6 authorization gate.
  const authResult = await auth()
  if (!authResult.ok) {
    // #134: this refusal previously reused the teleport-OUT copy — "say
    // 'teleport this session'" routes to dc_resume_in_terminal and does
    // the OPPOSITE of importing. Import has no message-lane equivalent,
    // so the only recovery is a solo chat.
    const message = authResult.reason === 'needs-confirmation'
      ? "Importing a session can't be authorized from a group tap — open the teleport card from a chat where it's just the two of us and attach it there."
      : 'No owner found for this chat.'
    await ctx.client.sendWebXDCUpdate(msgId, JSON.stringify({
      payload: {
        type: 'resume_attach_err',
        requestId,
        message,
        version: getTeleportVersion(),
        senderAddr: 'server',
      },
      summary: 'Attach unauthorized',
    })).catch(() => {})
    return
  }

  try {
    // Resolve the owner contact for the new chat.
    let ownerContactId = access.firstPermissionedContact(sourceChatId)
    if (!ownerContactId) {
      try {
        const contacts = await ctx.client.getChatContacts(sourceChatId)
        const found = contacts.find(id => id !== 1)
        if (!found) {
          ctx.logf('teleport: could not find contact in source chat %d', sourceChatId)
          return
        }
        ownerContactId = found
      } catch (err) {
        ctx.logf('teleport: getChatContacts failed for chat %d: %v', sourceChatId, err)
        return
      }
    }

    if (sessionLive(sessionId)) {
      ctx.logf('teleport: session %s appears active in terminal, warning user', sessionId)
      await ctx.client.sendWebXDCUpdate(msgId, JSON.stringify({
        payload: {
          type: 'resume_attach_err',
          requestId,
          message: 'This session appears to be active in a terminal. Close it first, then try again.',
          version: getTeleportVersion(),
          senderAddr: 'server',
        },
        summary: 'Session active',
      }))
      return
    }
    const candidates = listCandidates()
    const candidate = candidates.find(c => c.sessionId === sessionId)

    const agentId = resolveAttachAgent(sessionId, sourceChatId)
    ctx.logf('teleport: resume agent resolution: session=%s resolved=%s', sessionId, agentId)
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
    // #139: badge only — the import posts its own recap; a 'new agent'
    // greeting here would misrepresent a resumed session.
    if (agent) await decorateAgentChat(ctx, newChatId, agent, 'none')

    ctx.logf('teleport: resume-import created chat %d with session %s for owner %d', newChatId, sessionId, ownerContactId)

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
        version: getTeleportVersion(),
        senderAddr: 'server',
      },
      summary: 'Attached',
    })
    await ctx.client.sendWebXDCUpdate(msgId, update)

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
      ctx.dispatchAndCollect(newChatId, summaryPrompt).then(async resp => {
        // #128: the recap itself was silently discarded — only the
        // CHAT_NAME line was consumed. Post the summary (minus the
        // control line) so the imported chat opens with the promised
        // "what we were working on" context.
        const recap = resp.replace(/^\s*CHAT_NAME:.*$/im, '').trim()
        if (recap) {
          await ctx.client.send(newChatId, recap).catch(err =>
            ctx.logf('teleport: recap send failed chat=%d: %v', newChatId, err))
        }
        if (!candidate?.sessionName) {
          const nameMatch = resp.match(/CHAT_NAME:\s*(.+)/i)
          if (nameMatch) {
            const chatName = nameMatch[1].trim().slice(0, 50)
            return ctx.client.setChatName(newChatId, chatName)
          }
        }
      }).catch(err => {
        ctx.logf('teleport: resume-import summary dispatch failed: %v', err)
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
    ctx.logf('teleport: resume_attach failed: %v', err)
    try {
      await ctx.client.sendWebXDCUpdate(msgId, JSON.stringify({
        payload: {
          type: 'resume_attach_err',
          requestId,
          message: msg,
          version: getTeleportVersion(),
          senderAddr: 'server',
        },
        summary: 'Attach failed',
      }))
    } catch (sendErr) {
      ctx.logf('teleport: resume_attach_err send failed: %v', sendErr)
    }
  }
}

// ── WebXDCApp implementation ─────────────────────────────────────────────

export const teleportApp: WebXDCApp = {
  id: 'teleport',

  tools(): ToolDef[] {
    return [
      {
        name: 'dc_open_teleport_card',
        description:
          'Open the Teleport card in a chat. Lets the user teleport a DC chat session back to a terminal (teleport-out), or attach a terminal Claude Code session into a new DC chat (resume-attach). ' +
          'Sends a self-contained WebXDC app card into the chat. ' +
          'chat_id is REQUIRED — pass the caller\'s bound chat ID (the chat you are operating in). ' +
          'Parameters: chat_id (required — the chat to open the teleport card in, should be the caller\'s bound chat), view (optional — \'here\' or \'to_cli\' to open directly on that screen).',
        inputSchema: {
          type: 'object',
          properties: {
            chat_id: {
              type: 'string',
              description: 'DC chat ID to send the teleport card into. Should be the caller\'s bound chat.',
            },
            view: {
              type: 'string',
              enum: ['here', 'to_cli'],
              description: '\'here\' opens the import view (bring a terminal session into this chat); \'to_cli\' opens the send-to-terminal view (default).',
            },
          },
          required: ['chat_id'],
        },
        requiresCapability: 'real_world_action',
      },
    ]
  },

  async callTool(name: string, args: Record<string, unknown>, ctx: AppContext): Promise<ToolResult | null> {
    if (name !== 'dc_open_teleport_card') return null

    const rawChatId = args.chat_id
    const targetChatId = typeof rawChatId === 'string' && rawChatId.length > 0
      ? Number(rawChatId)
      : NaN

    if (!Number.isFinite(targetChatId)) {
      return {
        content: [{ type: 'text', text: 'dc_open_teleport_card: chat_id is required (the chat to open the teleport card in).' }],
        isError: true,
      }
    }

    // Normalize to the card's vocabulary: 'here' → import view; anything else → to_cli.
    const normalizedView: 'here' | 'to_cli' =
      typeof args.view === 'string' && args.view === 'here' ? 'here' : 'to_cli'

    try {
      const { xdcPath } = await buildTeleportXDC()
      const msgId = await ctx.client.sendWebXDC(targetChatId, xdcPath)
      teleportSessions.set(msgId, targetChatId)
      ctx.registerWebXDCMsg(msgId, teleportApp, targetChatId)

      // Send the init update so the card knows which view to open.
      await ctx.client.sendWebXDCUpdate(msgId, JSON.stringify({
        payload: {
          type: 'init',
          view: normalizedView,
          version: getTeleportVersion(),
          senderAddr: 'server',
        },
        summary: 'Teleport',
        info: 'Tap to open Teleport',
        href: 'index.html',
      }))

      return {
        content: [{
          type: 'text',
          text: `Teleport card opened in chat ${targetChatId} (view=${normalizedView}).`,
        }],
      }
    } catch (err) {
      ctx.logf('teleport: dc_open_teleport_card failed: %v', err)
      return {
        content: [{ type: 'text', text: `dc_open_teleport_card failed: ${(err as Error).message}` }],
        isError: true,
      }
    }
  },

  async onWebXDCUpdate(msgId: number, updates: WebXDCUpdate[], ctx: AppContext): Promise<void> {
    const chatId = teleportSessions.get(msgId)
    if (chatId === undefined) {
      ctx.logf('teleport: onWebXDCUpdate for unregistered msgId %d', msgId)
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

      if (payload.type === 'resume_list_request') {
        const requestId = typeof payload.requestId === 'number' ? payload.requestId : 0
        const candidates = listCandidates()
        try {
          const update = JSON.stringify({
            payload: {
              type: 'resume_list',
              requestId,
              candidates,
              version: getTeleportVersion(),
              senderAddr: 'server',
            },
            summary: 'Session list',
          })
          await ctx.client.sendWebXDCUpdate(msgId, update)
        } catch (err) {
          ctx.logf('teleport: resume_list send failed: %v', err)
        }
        continue
      }

      if (payload.type === 'teleport_out_list_request') {
        const requestId = typeof payload.requestId === 'number' ? payload.requestId : 0
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
          // Mark which row is the card's own chat so the UI can pin/badge it.
          markCurrentChat(list, chatId)
          await ctx.client.sendWebXDCUpdate(msgId, JSON.stringify({
            payload: {
              type: 'teleport_out_list',
              requestId,
              chats: list,
              version: getTeleportVersion(),
              senderAddr: 'server',
            },
            summary: 'Teleport-out list',
          }))
        } catch (err) {
          ctx.logf('teleport: teleport_out_list_request failed: %v', err)
        }
        continue
      }

      if (payload.type === 'teleport_out_commit') {
        await handleTeleportOutCommit(ctx, msgId, payload, auth)
        continue
      }

      if (payload.type === 'resume_attach') {
        await handleResumeAttach(ctx, msgId, chatId, payload, auth)
        continue
      }
    }
  },

  // #114: refill teleportSessions from the persisted card-session store at
  // boot so a card opened before a restart keeps answering taps.
  restoreSession(msgId: number, chatId: number): void {
    teleportSessions.set(msgId, chatId)
  },

  start(ctx: AppContext): void {
    ctx.logf('teleport: app started')
  },
}
