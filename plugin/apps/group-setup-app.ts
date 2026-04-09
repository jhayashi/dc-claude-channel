/**
 * Group setup WebXDC app — sends a setup card into a paired chat that
 * lets the user pick a group type, edit the name and system prompt, then
 * creates a new DC group with that config persisted to groups storage.
 */

import type { WebXDCApp, ToolDef, ToolResult, AppContext } from '../webxdc-app.js'
import type { WebXDCUpdate } from '../dc-client.js'
import * as groupSetup from '../group-setup.js'
import * as groups from '../groups.js'
import * as access from '../access.js'

interface Session {
  msgId: number
  sourceChatId: number
  draft: groups.GroupContext
}

// Sessions are keyed by the chat the user is messaging from (source chat).
// One active setup card per source chat.
const sessions = new Map<number, Session>()

function defaultsByType(): Record<groups.GroupType, { systemPrompt: string; model: string; inheritClaudeMd: boolean }> {
  const out: Partial<Record<groups.GroupType, { systemPrompt: string; model: string; inheritClaudeMd: boolean }>> = {}
  for (const [k, v] of Object.entries(groups.GROUP_TYPES) as Array<[groups.GroupType, typeof groups.GROUP_TYPES[groups.GroupType]]>) {
    out[k] = { systemPrompt: v.defaultPrompt, model: v.model, inheritClaudeMd: v.inheritClaudeMd }
  }
  return out as Record<groups.GroupType, { systemPrompt: string; model: string; inheritClaudeMd: boolean }>
}

async function sendInit(
  ctx: AppContext,
  app: WebXDCApp,
  sourceChatId: number,
  draft: groups.GroupContext,
): Promise<Session> {
  // Reuse existing session if present.
  const existing = sessions.get(sourceChatId)
  const payload = {
    type: 'init' as const,
    version: groupSetup.getGroupSetupVersion(),
    draft: { ...draft, _defaultsByType: defaultsByType() },
  }
  // Info text MUST be unique per call — DC dedupes consecutive identical
  // info text and the user gets no notification. Include the draft name
  // so each setup card produces a fresh tappable info message.
  const prefix = 'Tap to setup group: '
  const maxName = 80 - prefix.length
  const shortName = draft.name.length > maxName ? draft.name.slice(0, maxName - 1) + '\u2026' : draft.name
  const update = JSON.stringify({
    payload,
    summary: 'Group setup',
    info: prefix + shortName,
    href: 'index.html',
  })

  if (existing) {
    existing.draft = draft
    await ctx.client.sendWebXDCUpdate(existing.msgId, update)
    return existing
  }

  const { xdcPath } = await groupSetup.buildGroupSetupXDC()
  const msgId = await ctx.client.sendWebXDC(sourceChatId, xdcPath)
  try {
    const { unlinkSync } = await import('node:fs')
    unlinkSync(xdcPath)
  } catch {}
  await ctx.client.sendWebXDCUpdate(msgId, update)
  const session: Session = { msgId, sourceChatId, draft }
  sessions.set(sourceChatId, session)
  ctx.registerWebXDCMsg(msgId, app, sourceChatId)
  ctx.logf('group-setup: sent app (msg %d) to chat %d', msgId, sourceChatId)
  return session
}

export const groupSetupApp: WebXDCApp = {
  id: 'group-setup',

  instructions:
    'When the user wants to create a new Delta Chat group with a specific behavior ' +
    '(coding assistant, quick Q&A, general chat, etc.), call dc_propose_group with ' +
    'their description. This sends a setup card to the chat for them to confirm.',

  tools(): ToolDef[] {
    return [
      {
        name: 'dc_propose_group',
        description:
          'Send a group setup card to the user. The card lets them pick a group type, ' +
          'edit the name/prompt, and create a new DC group with that config.',
        inputSchema: {
          type: 'object',
          properties: {
            source_chat_id: {
              type: 'string',
              description: 'The chat the user is messaging from (where to send the setup card).',
            },
            description: {
              type: 'string',
              description: 'Free-form description of what the group is for.',
            },
          },
          required: ['source_chat_id', 'description'],
        },
      },
    ]
  },

  async callTool(name: string, args: Record<string, unknown>, ctx: AppContext): Promise<ToolResult | null> {
    if (name !== 'dc_propose_group') return null

    const sourceChatId = Number(args.source_chat_id as string)
    if (!sourceChatId || Number.isNaN(sourceChatId)) {
      return { content: [{ type: 'text', text: 'dc_propose_group: invalid source_chat_id' }], isError: true }
    }
    if (!ctx.isAllowed(sourceChatId)) {
      return { content: [{ type: 'text', text: `dc_propose_group: chat ${sourceChatId} not allowed` }], isError: true }
    }
    const description = ((args.description as string) ?? '').trim()
    if (!description) {
      return { content: [{ type: 'text', text: 'dc_propose_group: description is required' }], isError: true }
    }

    const draft = groups.draftConfigFromDescription(description)
    try {
      await sendInit(ctx, groupSetupApp, sourceChatId, draft)
    } catch (err) {
      ctx.logf('group-setup: send failed: %v', err)
      return { content: [{ type: 'text', text: `dc_propose_group: send failed: ${(err as Error).message}` }], isError: true }
    }

    return {
      content: [{
        type: 'text',
        text: `Setup card sent to chat ${sourceChatId} (drafted as type=${draft.type}, model=${draft.model}). Tap to review and confirm.`,
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
      const payload = u.payload as { type?: string; config?: unknown; appVersion?: number; serverVersion?: number } | null
      if (!payload) continue

      if (payload.type === 'version_mismatch') {
        // Guard against double-handling.
        const current = sessions.get(session.sourceChatId)
        if (!current || current.msgId !== msgId) return
        ctx.logf('group-setup: version mismatch from chat %d, resending app', session.sourceChatId)
        ctx.unregisterWebXDCMsg(msgId)
        sessions.delete(session.sourceChatId)
        try {
          await sendInit(ctx, groupSetupApp, session.sourceChatId, session.draft)
        } catch (err) {
          ctx.logf('group-setup: resend after version mismatch failed: %v', err)
        }
        return
      }

      if (payload.type === 'create') {
        const parsed = groups.GroupConfigSchema.safeParse(payload.config)
        if (!parsed.success) {
          ctx.logf('group-setup: invalid config from chat %d: %v', session.sourceChatId, parsed.error)
          continue
        }
        const cfg = parsed.data

        // Get the owner of the source chat — they'll become the owner of the new group.
        const ownerContactId = access.getOwner(session.sourceChatId)
        if (!ownerContactId) {
          ctx.logf('group-setup: source chat %d has no owner; aborting create', session.sourceChatId)
          continue
        }

        try {
          const newChatId = await ctx.client.createGroup(cfg.name)
          await ctx.client.addContactToChat(newChatId, ownerContactId)
          access.addChat(newChatId, ownerContactId)
          groups.setGroupContext(newChatId, cfg)

          // Send an intro message so the group materializes on the owner's device.
          // Without this, DC won't deliver the group until *someone* sends to it.
          try {
            await ctx.client.send(
              newChatId,
              `Hi! This is your new "${cfg.name}" group (${cfg.type}). Send a message here to get started.`,
            )
          } catch (err) {
            ctx.logf('group-setup: intro message send failed: %v', err)
          }

          ctx.logf('group-setup: created group %d (%s) for owner %d', newChatId, cfg.name, ownerContactId)

          // Notify the app of success.
          const update = JSON.stringify({
            payload: { type: 'created', chatId: newChatId, name: cfg.name },
            summary: 'Group created',
          })
          await ctx.client.sendWebXDCUpdate(session.msgId, update)

          // Clear session — one card, one creation.
          ctx.unregisterWebXDCMsg(msgId)
          sessions.delete(session.sourceChatId)
        } catch (err) {
          ctx.logf('group-setup: create failed: %v', err)
        }
      }
    }
  },
}
