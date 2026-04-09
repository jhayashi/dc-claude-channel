import { z } from 'zod'
import type { WebXDCApp, ToolDef, ToolResult, AppContext } from '../webxdc-app.js'
import type { WebXDCUpdate } from '../dc-client.js'
import * as permissions from '../permissions.js'

// Module-scoped state — shared between registerNotifications and onWebXDCUpdate.
let pendingPermissionRequestId: string | null = null
let pendingPermissionParams: { tool_name: string; description: string; input_preview: string } | null = null
const permissionsSessions = new Map<number, { msgId: number }>()
let savedCtx: AppContext | null = null

/** Register an existing permissions .xdc msgId for a chat (used by tutorial to pre-send bare apps). */
export function registerPermissionsSession(chatId: number, msgId: number): void {
  permissionsSessions.set(chatId, { msgId })
}

export async function sendPermissionRequest(
  ctx: AppContext,
  app: WebXDCApp,
  request_id: string,
  tool_name: string,
  description: string,
  input_preview: string,
  targetChatId?: number,
): Promise<void> {
  ctx.logf('permission: received request %s for tool %s', request_id, tool_name)

  // Use explicit target if provided. Otherwise (terminal Claude Code
  // permission prompts with no chat_id), broadcast only to 1:1 chats —
  // permission prompts in groups leak tool details to every member and
  // spam everyone's notifications. If no 1:1 chats exist, fall back to
  // all allowed chats so the prompt isn't dropped silently.
  let chats: number[]
  if (targetChatId && ctx.isAllowed(targetChatId)) {
    chats = [targetChatId]
  } else {
    const all = ctx.allowedChats()
    const singles: number[] = []
    for (const chatId of all) {
      try {
        if (await ctx.client.isSingleChat(chatId)) singles.push(chatId)
      } catch (err) {
        ctx.logf('permission: isSingleChat(%d) failed: %v', chatId, err)
      }
    }
    if (singles.length > 0) {
      chats = singles
    } else {
      ctx.logf('permission: no 1:1 chats found, falling back to all allowed chats')
      chats = all
    }
  }
  if (chats.length === 0) {
    ctx.logf('permission: no allowed chats to send permission prompt to')
    return
  }

  // Auto-deny any superseded request so it doesn't hang in Claude Code.
  if (pendingPermissionRequestId) {
    ctx.logf('permission: auto-denying superseded request %s', pendingPermissionRequestId)
    ctx.mcp.notification({
      method: 'notifications/claude/channel/permission',
      params: { request_id: pendingPermissionRequestId, behavior: 'deny' },
    }).catch(err => ctx.logf('permission: auto-deny send error: %v', err))
  }

  pendingPermissionRequestId = request_id
  pendingPermissionParams = { tool_name, description, input_preview }

  // Build the info message
  const prefix = 'Tap to review permission for: '
  const maxTool = 80 - prefix.length
  const shortTool = tool_name.length > maxTool ? tool_name.slice(0, maxTool - 1) + '\u2026' : tool_name
  const infoText = prefix + shortTool

  const update = JSON.stringify({
    payload: {
      type: 'request',
      version: permissions.getPermissionsVersion(),
      requestId: request_id,
      toolName: tool_name,
      description,
      inputPreview: input_preview,
    },
    summary: 'Pending permission',
    info: infoText,
    href: `index.html#${request_id}`,
  })

  for (const chatId of chats) {
    try {
      let session = permissionsSessions.get(chatId)
      if (!session) {
        const { xdcPath } = await permissions.buildPermissionsXDC()
        const msgId = await ctx.client.sendWebXDC(chatId, xdcPath)
        const { unlinkSync } = await import('node:fs')
        try { unlinkSync(xdcPath) } catch {}
        session = { msgId }
        permissionsSessions.set(chatId, session)
        ctx.registerWebXDCMsg(msgId, app, chatId)
        ctx.logf('permission: sent app (msg %d) to chat %d', msgId, chatId)
      }
      await ctx.client.sendWebXDCUpdate(session.msgId, update)
      ctx.logf('permission: sent request %s to chat %d (msg %d)', request_id, chatId, session.msgId)
    } catch (err) {
      ctx.logf('permission: send to chat %d failed: %v', chatId, err)
    }
  }
}

export const permissionsApp: WebXDCApp = {
  id: 'permissions',

  tools(): ToolDef[] {
    return [
      {
        name: 'dc_test_permission',
        description: 'Send a fake permission request to test the permissions WebXDC app. Simulates what happens when Claude Code asks for permission to use a tool.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            chat_id: { type: 'string', description: 'Chat ID to send the test request to' },
            tool_name: { type: 'string', description: 'Fake tool name (e.g. "Bash(rm -rf /)")' },
          },
          required: ['chat_id'],
        },
      },
    ]
  },

  async callTool(name: string, args: Record<string, unknown>, ctx: AppContext): Promise<ToolResult | null> {
    if (name !== 'dc_test_permission') return null

    const chatId = Number(args.chat_id as string)
    if (!chatId || Number.isNaN(chatId)) {
      return { content: [{ type: 'text', text: 'dc_test_permission: invalid chat_id' }], isError: true }
    }
    if (!ctx.isAllowed(chatId)) {
      return { content: [{ type: 'text', text: `dc_test_permission: chat ${chatId} not allowed` }], isError: true }
    }

    const toolName = ((args.tool_name as string) ?? '').trim() || 'Bash(echo "hello world")'
    const requestId = `test-${Date.now()}`

    await sendPermissionRequest(
      ctx,
      permissionsApp,
      requestId,
      toolName,
      `Test permission request for ${toolName}`,
      JSON.stringify({ command: toolName }),
      chatId,
    )

    return { content: [{ type: 'text', text: `Test permission sent (request ${requestId}). Open the app and tap Allow or Deny.` }] }
  },

  registerNotifications(ctx: AppContext): void {
    savedCtx = ctx
    ctx.mcp.setNotificationHandler(
      z.object({
        method: z.literal('notifications/claude/channel/permission_request'),
        params: z.object({
          request_id: z.string(),
          tool_name: z.string(),
          description: z.string(),
          input_preview: z.string(),
        }),
      }),
      async ({ params }) => {
        // Terminal-generated permissions are handled by Claude's built-in permission-mode.
        // Only subagent permissions (which pass chatId via socket) should route through DC.
        // This prevents leaking tool details to DC chats and avoids redundant prompts.
        ctx.logf('permission: skipping DC broadcast for terminal request %s (will use terminal permission-mode)', params.request_id)
      },
    )
  },

  async onWebXDCUpdate(msgId: number, updates: WebXDCUpdate[], ctx: AppContext): Promise<void> {
    if (!pendingPermissionRequestId) return

    // Find which chat owns this msgId
    let ownerChatId: number | null = null
    for (const [chatId, session] of permissionsSessions) {
      if (session.msgId === msgId) { ownerChatId = chatId; break }
    }
    if (ownerChatId === null) return

    const session = permissionsSessions.get(ownerChatId)!
    for (const u of updates) {
      const payload = u.payload as { type?: string } | null
      if (!payload) continue

      if (payload.type === 'version_mismatch') {
        // Guard: check session still owns this msgId (concurrent handler may have already upgraded)
        const currentSession = permissionsSessions.get(ownerChatId)
        if (!currentSession || currentSession.msgId !== msgId) return

        ctx.logf('permission: version mismatch from chat %d, resending app', ownerChatId)
        ctx.unregisterWebXDCMsg(session.msgId)
        permissionsSessions.delete(ownerChatId)
        if (pendingPermissionRequestId && pendingPermissionParams) {
          await sendPermissionRequest(
            ctx,
            permissionsApp,
            pendingPermissionRequestId,
            pendingPermissionParams.tool_name,
            pendingPermissionParams.description,
            pendingPermissionParams.input_preview,
          )
        }
        return // session was deleted
      }

      if (payload.type !== 'response') continue
      const resp = payload as { type: string; requestId?: string; granted?: boolean; senderName?: string }
      if (resp.requestId !== pendingPermissionRequestId) continue

      const behavior = resp.granted ? 'allow' : 'deny'
      ctx.logf('permission: response from chat %d (%s): %s for %s', ownerChatId, resp.senderName ?? 'unknown', behavior, resp.requestId)
      ctx.mcp.notification({
        method: 'notifications/claude/channel/permission',
        params: { request_id: resp.requestId, behavior },
      }).catch(err => ctx.logf('permission: verdict send error: %v', err))
      pendingPermissionRequestId = null
      pendingPermissionParams = null
    }
  },

  stop(): void {
    for (const [, session] of permissionsSessions) {
      savedCtx?.unregisterWebXDCMsg(session.msgId)
    }
    pendingPermissionRequestId = null
    permissionsSessions.clear()
  },
}
