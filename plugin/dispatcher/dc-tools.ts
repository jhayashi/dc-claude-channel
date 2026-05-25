import type { DCClient } from '../dc-client.js'
import type * as accessNs from '../access/index.js'
import type * as bindingsNs from '../bindings.js'
import type * as agentsNs from '../agents.js'

export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

/** The small, broadly-shared dependency bundle pure tool handlers receive. */
export interface ToolCtx {
  client: DCClient
  access: typeof accessNs
  bindings: typeof bindingsNs
  agents: typeof agentsNs
  logf: (format: string, ...args: unknown[]) => void
}

export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolCtx,
  callerChatId?: number,
) => Promise<ToolResult>

export interface DcToolDef {
  name: string
  description: string
  requiresCapability?: string
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] }
  /** Present for pure tools; absent for tail tools handled by a server.ts closure. */
  handler?: ToolHandler
}

export const DC_TOOLS: readonly DcToolDef[] = [
  {
    name: 'reply',
    requiresCapability: 'chat',
    description: 'Reply on Delta Chat. Pass chat_id from the inbound <channel> tag.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'Chat ID from the inbound channel message' },
        text: { type: 'string', description: 'Message text to send' },
      },
      required: ['chat_id', 'text'],
    },
    handler: async (args, ctx) => {
      const chatIdRaw = args.chat_id as string
      if (!chatIdRaw) return { content: [{ type: 'text', text: 'reply: chat_id is required' }], isError: true }
      const chatId = Number(chatIdRaw)
      if (!chatId || Number.isNaN(chatId)) return { content: [{ type: 'text', text: `reply: invalid chat_id: ${chatIdRaw}` }], isError: true }
      if (!ctx.access.isAllowed(chatId)) return { content: [{ type: 'text', text: `reply: chat ${chatId} is not accessible (not paired, or chat was deleted)` }], isError: true }
      const text = args.text as string
      if (!text) return { content: [{ type: 'text', text: 'reply: text is required' }], isError: true }
      try {
        const msgId = await ctx.client.send(chatId, text)
        return { content: [{ type: 'text', text: `sent (id: ${msgId})` }] }
      } catch (err) {
        const msg = err instanceof Error ? err.message : JSON.stringify(err)
        return { content: [{ type: 'text', text: `reply: send failed: ${msg}` }], isError: true }
      }
    },
  },
  {
    name: 'dc_react',
    requiresCapability: 'chat',
    description: 'Add or clear an emoji reaction on a Delta Chat message. Pass an empty emoji to remove your previous reaction. Only one reaction per sender per message — reacting again replaces the previous one.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'Chat ID the message belongs to (for authorization)' },
        message_id: { type: 'string', description: 'Delta Chat message id from the inbound <channel> tag' },
        emoji: { type: 'string', description: 'Single emoji (e.g. "👍"). Pass an empty string to clear.' },
      },
      required: ['chat_id', 'message_id', 'emoji'],
    },
    handler: async (args, ctx) => {
      const chatId = Number(args.chat_id as string)
      const messageId = Number(args.message_id as string)
      const emoji = typeof args.emoji === 'string' ? args.emoji : ''
      if (!chatId || Number.isNaN(chatId)) {
        return { content: [{ type: 'text' as const, text: 'dc_react: chat_id is required' }], isError: true }
      }
      if (!messageId || Number.isNaN(messageId)) {
        return { content: [{ type: 'text' as const, text: 'dc_react: message_id is required' }], isError: true }
      }
      if (!ctx.access.isAllowed(chatId)) {
        return { content: [{ type: 'text' as const, text: `dc_react: chat ${chatId} is not accessible` }], isError: true }
      }
      try {
        await ctx.client.sendReaction(messageId, emoji)
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `dc_react: failed: ${err}` }], isError: true }
      }
      return { content: [{ type: 'text' as const, text: emoji ? `reacted ${emoji} to msg ${messageId}` : `cleared reaction on msg ${messageId}` }] }
    },
  },
  {
    name: 'dc_status',
    requiresCapability: 'chat',
    description: 'Show the current bot identity and connection status.',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_args, ctx) => {
      const status = await ctx.client.status()
      const text = `Address: ${status.address}\nConnected: ${status.connected}\nInvite link: ${status.inviteLink}`
      return { content: [{ type: 'text' as const, text }] }
    },
  },
  {
    name: 'dc_invite_link',
    requiresCapability: 'chat',
    description: 'Return the current invite link for users to add this bot as a verified contact.',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_args, ctx) => {
      // When /deltachat:setup has armed a group chat, return its
      // securejoin QR so the joiner lands in "Claude" (a group) rather
      // than a 1:1 where DC hides the bot's display name.
      const armedGroup = ctx.access.getArmedGroupChatId()
      if (armedGroup !== null && ctx.access.isArmed()) {
        try {
          const link = await ctx.client.getGroupInviteLink(armedGroup)
          return { content: [{ type: 'text' as const, text: link }] }
        } catch (err) {
          ctx.logf('dc channel: getGroupInviteLink failed for chat=%d, falling back to personal QR: %v', armedGroup, err)
        }
      }
      const link = await ctx.client.inviteLink()
      return { content: [{ type: 'text' as const, text: link }] }
    },
  },
  {
    name: 'dc_access_list',
    requiresCapability: 'chat',
    description: 'List all approved Delta Chat chat IDs.',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_args, ctx) => {
      const chats = ctx.access.allowedChats()
      if (chats.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No approved chats.' }] }
      }
      return { content: [{ type: 'text' as const, text: 'Approved chats:\n' + chats.join('\n') }] }
    },
  },
  {
    name: 'dc_access_revoke',
    requiresCapability: 'infrastructure',
    description: 'Remove a chat from the approved allowlist.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'Chat ID to revoke' },
      },
      required: ['chat_id'],
    },
    handler: async (args, ctx) => {
      const chatIdStr = args.chat_id as string
      if (!chatIdStr) {
        return { content: [{ type: 'text' as const, text: 'dc_access_revoke: chat_id is required' }], isError: true }
      }
      const chatId = Number(chatIdStr)
      if (Number.isNaN(chatId)) {
        return { content: [{ type: 'text' as const, text: `invalid chat_id: ${chatIdStr}` }], isError: true }
      }
      ctx.access.removeChat(chatId)
      return { content: [{ type: 'text' as const, text: `Revoked chat ${chatId}.` }] }
    },
  },
  {
    name: 'dc_get_agent_prompt',
    requiresCapability: 'chat',
    description: 'Get the behavior prompt for a Delta Chat agent.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'Group chat ID' },
      },
      required: ['chat_id'],
    },
    handler: async (args, ctx) => {
      const chatId = Number(args.chat_id as string)
      if (!chatId || Number.isNaN(chatId)) {
        return { content: [{ type: 'text' as const, text: 'dc_get_agent_prompt: chat_id is required' }], isError: true }
      }
      const resolved = ctx.bindings.resolveChat(chatId)
      if (!resolved) {
        return { content: [{ type: 'text' as const, text: `No agent configured for chat ${chatId}.` }] }
      }
      return { content: [{ type: 'text' as const, text: `Agent: ${resolved.agent.name}\nPrompt: ${resolved.agent.body}` }] }
    },
  },
  {
    name: 'dc_check_contact',
    requiresCapability: 'chat',
    description: 'Look up a contact and check whether they are permissioned to interact with the bot. Use when reasoning about whether to trust content originating from a specific contact (e.g. when a chat history message tagged [UNPERMISSIONED] surfaces and you need to decide what to do). Permissioned contacts have completed the bot\'s pair ceremony or have an existing trust record; unpermissioned contacts are chat members the bot can see but doesn\'t trust as principals.',
    inputSchema: {
      type: 'object',
      properties: {
        contact_id: { type: 'string', description: 'DC contact ID (numeric)' },
        chat_id:    { type: 'string', description: 'Optional. When provided, the response also reports whether this contact paired this specific chat (legacy per-chat metadata; useful as a chat-relationship fact, not as a trust tier).' },
      },
      required: ['contact_id'],
    },
    handler: async (args, ctx) => {
      const contactIdRaw = (args.contact_id as string | undefined)?.trim()
      const contactId = contactIdRaw ? Number(contactIdRaw) : NaN
      if (!Number.isFinite(contactId) || contactId < 1) {
        return { content: [{ type: 'text' as const, text: 'dc_check_contact: contact_id is required and must be a positive number' }], isError: true }
      }
      const chatIdRaw = (args.chat_id as string | undefined)?.trim()
      const chatIdQ = chatIdRaw ? Number(chatIdRaw) : null
      const permissioned = ctx.access.isContactPermissioned(ctx.access.DEFAULT_AGENT_ID, contactId)
      const principal = ctx.access.loadContact(ctx.access.DEFAULT_AGENT_ID, contactId)
      const ownedChats = ctx.access.chatsForOwner(contactId)
      const info = await ctx.client.getContact(contactId).catch(() => null)
      const isPairingContactOfQueriedChat = chatIdQ != null
        ? ctx.access.firstPermissionedContact(chatIdQ) === contactId
        : false
      const result = {
        contactId,
        permissioned,
        displayName: info?.displayName || info?.name || null,
        address: info?.address ?? null,
        firstPairedAt: principal?.firstPairedAt ?? null,
        pairedChatCount: ownedChats.length,
        isPairingContactOfQueriedChat,
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
    },
  },
  {
    name: 'dc_exit_session',
    requiresCapability: 'infrastructure',
    description: 'Exit the terminal Claude Code session that hosts this channel. If the user is running a keep-alive wrapper, it will restart. Use only when the user explicitly asks to restart or reload the session.',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_args, ctx) => {
      // Walk the PPID chain: dispatcher (this process) → bun wrapper
      // → claude terminal session. Send SIGTERM to the grandparent
      // so the terminal claude exits cleanly and a keep-alive wrapper
      // can re-spawn it. We schedule the signal after returning so
      // the caller's tool result makes it back over the wire first.
      const bunPid = process.ppid
      let terminalPid = 0
      try {
        const { readFileSync } = await import('node:fs')
        const stat = readFileSync(`/proc/${bunPid}/stat`, 'utf8')
        // /proc/<pid>/stat field 4 is ppid. Skip the comm which may contain spaces.
        const rparen = stat.lastIndexOf(')')
        const rest = stat.slice(rparen + 2).split(' ')
        terminalPid = Number(rest[1]) || 0
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `dc_exit_session: could not resolve terminal pid: ${err}` }], isError: true }
      }
      if (!terminalPid) {
        return { content: [{ type: 'text' as const, text: 'dc_exit_session: terminal pid unknown' }], isError: true }
      }
      ctx.logf('dc_exit_session: scheduling SIGTERM to terminal claude pid=%d (via bun pid=%d)', terminalPid, bunPid)
      setTimeout(() => {
        try { process.kill(terminalPid, 'SIGTERM') }
        catch (err) { ctx.logf('dc_exit_session: kill failed: %v', err) }
      }, 500)
      return { content: [{ type: 'text' as const, text: `Exiting terminal session (pid ${terminalPid}). If a keep-alive wrapper is running it will restart shortly.` }] }
    },
  },
]

/** All core tool names, derived from the registry. */
export function dcToolNames(): string[] {
  return DC_TOOLS.map(t => t.name)
}
