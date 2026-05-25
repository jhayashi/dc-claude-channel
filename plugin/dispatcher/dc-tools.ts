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
]

/** All core tool names, derived from the registry. */
export function dcToolNames(): string[] {
  return DC_TOOLS.map(t => t.name)
}
