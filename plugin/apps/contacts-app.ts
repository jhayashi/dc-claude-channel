/**
 * Contacts WebXDC app — standalone bespoke card for managing contact roles.
 * Ported from the two handlers in agent-setup-app.ts and gated by the §6
 * ControlAuthDeps authorization helper.
 *
 * Authorization note (§6): webXDC senderAddr is app-relayed and spoofable
 * (verified, dc-core 2.53). State-changing handlers MUST gate on
 * isControlCommandAuthorized rather than anything the card payload says.
 * Read-only handlers (list requests) do not need the gate.
 */

import type { WebXDCApp, ToolDef, ToolResult, AppContext } from '../webxdc-app.js'
import type { WebXDCUpdate } from '../dc-client.js'
import { getContactsVersion, buildContactsXDC } from '../contacts.js'
import {
  isControlCommandAuthorized,
  type ControlAuthDeps,
} from '../access/webxdc-control-auth.js'
import { handleListContacts, handleAssignRole } from './agent-setup-app.js'

// ── Module-level state ───────────────────────────────────────────────────

/** Maps msgId → chatId for registered contacts cards. */
const contactsSessions = new Map<number, number>()

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

export const contactsApp: WebXDCApp = {
  id: 'contacts',

  tools(): ToolDef[] {
    return [
      {
        name: 'dc_open_contacts_card',
        description:
          'Open the Contacts & Roles card in a chat. Lets the user view all contacts ' +
          'bound to the current agent and assign or change their roles. ' +
          'Sends a self-contained WebXDC app card into the chat. ' +
          'chat_id is REQUIRED — pass the caller\'s bound chat ID (the chat you are operating in).',
        inputSchema: {
          type: 'object',
          properties: {
            chat_id: {
              type: 'string',
              description: 'DC chat ID to send the contacts card into. Should be the caller\'s bound chat.',
            },
          },
          required: ['chat_id'],
        },
        requiresCapability: 'infrastructure',
      },
    ]
  },

  async callTool(name: string, args: Record<string, unknown>, ctx: AppContext): Promise<ToolResult | null> {
    if (name !== 'dc_open_contacts_card') return null

    const rawChatId = args.chat_id
    const targetChatId = typeof rawChatId === 'string' && rawChatId.length > 0
      ? Number(rawChatId)
      : NaN

    if (!Number.isFinite(targetChatId)) {
      return {
        content: [{ type: 'text', text: 'dc_open_contacts_card: chat_id is required (the chat to open the contacts card in).' }],
        isError: true,
      }
    }

    try {
      const { xdcPath } = await buildContactsXDC()
      const msgId = await ctx.client.sendWebXDC(targetChatId, xdcPath)
      contactsSessions.set(msgId, targetChatId)
      ctx.registerWebXDCMsg(msgId, contactsApp, targetChatId)

      // Send the init update so the card knows which chat context to load.
      await ctx.client.sendWebXDCUpdate(msgId, JSON.stringify({
        payload: {
          type: 'init',
          version: getContactsVersion(),
          senderAddr: 'server',
        },
        summary: 'Contacts & Roles',
        info: 'Tap to open Contacts',
        href: 'index.html',
      }))

      return {
        content: [{
          type: 'text',
          text: `Contacts card opened in chat ${targetChatId}.`,
        }],
      }
    } catch (err) {
      ctx.logf('contacts: dc_open_contacts_card failed: %v', err)
      return {
        content: [{ type: 'text', text: `dc_open_contacts_card failed: ${(err as Error).message}` }],
        isError: true,
      }
    }
  },

  async onWebXDCUpdate(msgId: number, updates: WebXDCUpdate[], ctx: AppContext): Promise<void> {
    const chatId = contactsSessions.get(msgId)
    if (chatId === undefined) {
      ctx.logf('contacts: onWebXDCUpdate for unregistered msgId %d', msgId)
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

      if (payload.type === 'list_contacts') {
        await handleListContacts(ctx, msgId, chatId)
        continue
      }

      if (payload.type === 'assign_role') {
        const contactId = typeof (payload as { contactId?: unknown }).contactId === 'number'
          ? (payload as { contactId: number }).contactId : null
        const role = typeof (payload as { role?: unknown }).role === 'string'
          ? (payload as { role: string }).role : null
        const senderAddr = typeof (payload as { senderAddr?: unknown }).senderAddr === 'string'
          ? (payload as { senderAddr: string }).senderAddr : null
        await handleAssignRole(ctx, msgId, chatId, contactId, role, senderAddr, auth)
        continue
      }
    }
  },

  start(ctx: AppContext): void {
    ctx.logf('contacts: app started')
  },
}
