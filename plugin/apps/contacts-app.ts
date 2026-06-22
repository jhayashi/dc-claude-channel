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
import * as bindings from '../bindings.js'
import * as access from '../access/index.js'
import { logRoleAssignment } from '../events.js'

// ── Handler functions ────────────────────────────────────────────────────

export async function handleListContacts(ctx: AppContext, msgId: number, sourceChatId: number): Promise<void> {
  // v1.4.9: the managed agent context for the Contacts UI is the agent
  // bound to the chat the agent-setup app was opened from. For an
  // unbound source chat (rare — opening Manage from a fresh DC chat),
  // getBindingAgentId falls back to claude-code so we show *something*
  // sensible rather than an empty UI.
  const managedAgentId = bindings.getBindingAgentId(sourceChatId)

  // Phase 4 (D3 — Knob 1 b): the picker universe is the members of
  // chats *bound to the managed agent*, not the bot's full address
  // book. Avoids cross-agent visibility leaks (e.g., a contact you
  // only know via librarian doesn't pollute dc-developer's role
  // picker). Pre-v1.4.9 the universe was `client.getChats()` (all
  // bot chats); the narrowing is the user-visible Phase 4 change.
  //
  // dc-core's getChatContacts filters add_timestamp >= remove_timestamp, so
  // ex-members (e.g. someone removed from a chat) are automatically
  // excluded. Using getContactIds instead would return phantom contacts
  // dc-core knows about via Autocrypt-Gossip but isn't currently chatting
  // with — Joe explicitly does NOT want those in the picker.
  const chatIds = bindings.listBindings()
    .filter(b => b.agentId === managedAgentId)
    .map(b => b.chatId)
  const seen = new Set<number>()
  for (const chatId of chatIds) {
    let members: number[] = []
    try { members = await ctx.client.getChatContacts(chatId) } catch { continue }
    for (const id of members) {
      if (id <= 9) continue // CONTACT_SELF (1) + DC reserved range (≤9)
      seen.add(id)
    }
  }

  const ownAddr = await ctx.client.getSelfAddress()

  const enriched = await Promise.all(Array.from(seen).map(async (contactId) => {
    let record: access.Contact | null = null
    try { record = access.loadContact(managedAgentId, contactId) } catch { /* corrupt → treat as unpaired */ }
    const info = await ctx.client.getContact(contactId)
    return {
      contactId,
      kind: 'human' as const,
      firstPairedAt: record?.firstPairedAt ?? null,
      role: record?.role ?? null,
      capabilities: record?.capabilities ?? null,
      displayName: info?.displayName ?? null,
      chatmailAddress: info?.address ?? null,
      isBot: info?.isBot ?? false,
    }
  }))

  // Bots are intentionally NOT filtered: we want to be able to permission
  // other DC bots (research bot → trusted-agent, third-party bot →
  // untrusted-agent, etc.). The only defensive filter is matching the
  // dispatcher's own address — that catches self-as-contact ghosts.
  const filtered = ownAddr
    ? enriched.filter(c => c.chatmailAddress !== ownAddr)
    : enriched

  await ctx.client.sendWebXDCUpdate(msgId, JSON.stringify({ payload: { type: 'contacts_loaded', contacts: filtered } }))
}

export async function handleAssignRole(
  ctx: AppContext,
  msgId: number,
  sourceChatId: number,
  contactId: number | null,
  role: string | null,
  senderAddr: string | null,
  auth: () => Promise<{ ok: true } | { ok: false; reason: 'no-owner' | 'needs-confirmation' }>,
): Promise<void> {
  if (!contactId || !role) return
  const authResult = await auth()
  if (!authResult.ok) {
    const message = authResult.reason === 'needs-confirmation'
      ? "Setting permissions in a group has to come from you directly — say it in our chat, or open this from your 1:1 with me."
      : 'No owner found for this chat.'
    await ctx.client.sendWebXDCUpdate(msgId, JSON.stringify({
      payload: { type: 'role_assign_err', contactId, message, senderAddr: 'server' },
    })).catch(() => {})
    return
  }
  // v1.4.9: write the role assignment to the *managed agent's* sidecar
  // (the agent bound to the chat the picker was launched from), not to
  // the canonical claude-code namespace. This makes per-agent role
  // divergence real: contact 11 can be subscriber for dc-developer and
  // family-member for librarian.
  const managedAgentId = bindings.getBindingAgentId(sourceChatId)

  // No early-return on unpaired contacts: per Option B the picker is the
  // path to first-time role assignment, so a missing record is expected
  // and setContactRole creates one with firstPairedAt = now.
  let previous: access.Contact | null = null
  try { previous = access.loadContact(managedAgentId, contactId) } catch { /* corrupt → treat as no prior */ }

  const assignerContactId = senderAddr
    ? await ctx.client.lookupContactByAddr(senderAddr)
    : null

  const updated = access.setContactRole(managedAgentId, contactId, role)
  logRoleAssignment({
    ts: new Date().toISOString(),
    assigneeContactId: contactId,
    assignedRole: role,
    previousRole: previous?.role ?? null,
    assignerContactId,
    reason: 'picked',
  })
  const info = await ctx.client.getContact(contactId)
  const enriched = {
    ...updated,
    displayName: info?.displayName ?? null,
    chatmailAddress: info?.address ?? null,
  }
  await ctx.client.sendWebXDCUpdate(msgId, JSON.stringify({ payload: { type: 'role_assigned', contact: enriched } }))
}

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
