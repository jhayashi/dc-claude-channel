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
import * as agents from '../agents.js'
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

  // #120: name the managed agent in the payload so the card can render
  // "Roles for <name>" — roles are per-agent (v1.4.9) but the card
  // previously never said which agent's roles it was showing.
  const managedAgentName = agents.getAgent(managedAgentId)?.['x-dc-display-name'] ?? managedAgentId

  await ctx.client.sendWebXDCUpdate(msgId, JSON.stringify({
    payload: { type: 'contacts_loaded', contacts: filtered, managedAgentId, managedAgentName },
  }))
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
    // #133: the old copy sent users to "your 1:1 chat with me", but the
    // picker there manages the 1:1's OWN bound agent (v1.4.9 per-agent
    // scoping) — usually not this group's agent, so the contact wouldn't
    // even appear. The recovery that actually works is an authenticated
    // chat message in THIS chat, which routes to dc_set_contact_role.
    const message = authResult.reason === 'needs-confirmation'
      ? "In a group I can't verify who tapped the card, so say it as a normal message instead — e.g. \"give Alice full access\" or \"make Bob chat-only\" — and I'll apply it from your message directly."
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

/**
 * dc_set_contact_role implementation (#133). Same write path as the card's
 * handleAssignRole — per-agent sidecar via the chat's bound agent, record
 * created on first assignment (Option B), audit-logged — but reached via an
 * authenticated chat message instead of an unauthenticatable card tap.
 */
async function handleSetContactRole(
  ctx: AppContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const chatId = typeof args.chat_id === 'string' && args.chat_id.length > 0
    ? Number(args.chat_id)
    : NaN
  const contactId = typeof args.contact_id === 'string' && args.contact_id.length > 0
    ? Number(args.contact_id)
    : NaN
  const role = typeof args.role === 'string' ? args.role.trim() : ''

  if (!Number.isFinite(chatId) || !Number.isFinite(contactId) || !role) {
    return {
      content: [{ type: 'text', text: 'dc_set_contact_role: chat_id, contact_id, and role are all required.' }],
      isError: true,
    }
  }
  if (!Object.prototype.hasOwnProperty.call(access.ROLES, role)) {
    return {
      content: [{
        type: 'text',
        text: `dc_set_contact_role: unknown role "${role}". Valid roles: ${Object.keys(access.ROLES).join(', ')}.`,
      }],
      isError: true,
    }
  }

  // Phase 0.2 invariant: the agent context is the agent bound to the chat
  // where the contact acts — not the asking subagent's own agent.
  const managedAgentId = bindings.getBindingAgentId(chatId)

  let previous: access.Contact | null = null
  try { previous = access.loadContact(managedAgentId, contactId) } catch { /* corrupt → treat as no prior */ }

  try {
    const updated = access.setContactRole(managedAgentId, contactId, role)
    logRoleAssignment({
      ts: new Date().toISOString(),
      assigneeContactId: contactId,
      assignedRole: role,
      previousRole: previous?.role ?? null,
      assignerContactId: null,
      reason: 'tool',
    })
    let displayName = updated.displayName || `Contact ${contactId}`
    try {
      const info = await ctx.client.getContact(contactId)
      if (info?.displayName) displayName = info.displayName
    } catch { /* keep fallback */ }
    const prevNote = previous?.role && previous.role !== role ? ` (was ${previous.role})` : ''
    return {
      content: [{
        type: 'text',
        text: `${displayName} (contact ${contactId}) is now "${role}"${prevNote} for agent "${managedAgentId}". ` +
          'Takes effect on their next message.',
      }],
    }
  } catch (err) {
    ctx.logf('contacts: dc_set_contact_role failed: %v', err)
    return {
      content: [{ type: 'text', text: `dc_set_contact_role failed: ${(err as Error).message}` }],
      isError: true,
    }
  }
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
      {
        name: 'dc_set_contact_role',
        description:
          'Directly assign a contact\'s role for the agent bound to a chat — the executable ' +
          'form of "give Alice full access" / "make Bob read-only" / "block Carol". ' +
          'Roles: subscriber (full access), trusted-agent (full access, for bots), ' +
          'family-member (chat + low-stakes actions — "limited"), guest (chat only — ' +
          '"read-only" / "chat-only"), untrusted-agent (chat only, for bots), ' +
          'no-permissions (ignored entirely — "block" / "no access"). ' +
          'chat_id determines WHICH agent\'s roles are edited (the chat\'s bound agent), ' +
          'so call it with the chat where the contact acts. Works in group chats — ' +
          'unlike the contacts card, which refuses taps in multi-human groups. ' +
          'Find contact IDs via dc_check_contact or dc_chat_history.',
        inputSchema: {
          type: 'object',
          properties: {
            chat_id: {
              type: 'string',
              description: 'DC chat ID whose bound agent\'s contact roles are being edited.',
            },
            contact_id: {
              type: 'string',
              description: 'DC contact ID of the person/bot whose role to set.',
            },
            role: {
              type: 'string',
              description: 'One of: subscriber, trusted-agent, family-member, guest, untrusted-agent, no-permissions.',
            },
          },
          required: ['chat_id', 'contact_id', 'role'],
        },
        requiresCapability: 'infrastructure',
      },
    ]
  },

  async callTool(name: string, args: Record<string, unknown>, ctx: AppContext): Promise<ToolResult | null> {
    if (name === 'dc_set_contact_role') {
      // NO §6/auth callback here by design (the dc_rebind_chat precedent):
      // this tool is only reachable via a real, DC-core-authenticated chat
      // message (fromId), and the dispatcher's capability gate
      // (requiresCapability: 'infrastructure', resolved against the actual
      // sender via _currentDriver) authorizes it before callTool runs. This
      // is the multi-human-group recovery path the card cannot provide —
      // its tap-driven assign_role is §6-refused there (#133).
      return handleSetContactRole(ctx, args)
    }
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
