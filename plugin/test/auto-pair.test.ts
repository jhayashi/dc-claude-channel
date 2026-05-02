/**
 * Tests for v0.8.3 auto-pair behavior.
 *
 * The actual branch lives in server.ts inside onIncomingMessage. These
 * tests exercise the same access.ts primitives in the same order to
 * verify the decision logic and persistence.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as access from '../access/index.js'

let tmpDir: string
let principalsTmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'dc-autopair-'))
  principalsTmpDir = mkdtempSync(join(tmpdir(), 'dc-autopair-principals-'))
  access.setApprovedDir(tmpDir)
  access.setPrincipalsDir(principalsTmpDir)
  access.setContactsAgentsDir(principalsTmpDir)
  // Module-level pending-pairings map leaks across test files; reset.
  access.resetPendingPairings()
  access.resetArmedState()
})

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  try { rmSync(principalsTmpDir, { recursive: true, force: true }) } catch {}
})

/**
 * Mirrors the server.ts decision in onIncomingMessage when a message
 * arrives in a chat that isn't yet allowed. Returns one of:
 *  - 'ignored'    — stranger lockout fired
 *  - 'auto-paired'— sender was a known owner; chat added
 *  - 'pair-flow'  — first-ever pairing flow would have run
 */
function decideUnpaired(chatId: number, fromId: number | undefined): 'ignored' | 'auto-paired' | 'pair-flow' | 'role-denied' {
  if (access.isAllowed(chatId)) throw new Error('test setup error: chat is already allowed')
  // #66 Option A — auth gate is contact identity (principal record OR
  // legacy chat-allowlist entry), not just chat-allowlist.
  if (access.hasAnyOwner() && fromId && !access.isContactPermissioned(access.DEFAULT_AGENT_ID, fromId)) {
    return 'ignored'
  }
  if (fromId && access.isContactPermissioned(access.DEFAULT_AGENT_ID, fromId)) {
    const contact = access.loadContact(access.DEFAULT_AGENT_ID, fromId)
    const role = contact?.role ?? 'subscriber' // null → legacy, treat as subscriber
    if (role !== 'subscriber' && role !== 'trusted-agent') {
      return 'role-denied'
    }
    access.addChat(chatId, fromId)
    return 'auto-paired'
  }
  return 'pair-flow'
}

test('no prior owner → first-ever pairing flow runs', () => {
  expect(decideUnpaired(10, 5)).toBe('pair-flow')
  expect(access.isAllowed(10)).toBe(false)
})

test('known owner in new chat → auto-pair with same owner', () => {
  access.addChat(10, 5)
  expect(decideUnpaired(20, 5)).toBe('auto-paired')
  expect(access.isAllowed(20)).toBe(true)
  expect(access.firstPermissionedContact(20)).toBe(5)
})

test('stranger in new chat with owners present → silent ignore', () => {
  access.addChat(10, 5)
  expect(decideUnpaired(20, 7)).toBe('ignored')
  expect(access.isAllowed(20)).toBe(false)
})

test('two known owners → each can auto-pair independently', () => {
  access.addChat(10, 5)
  access.addChat(11, 6)
  expect(decideUnpaired(30, 5)).toBe('auto-paired')
  expect(decideUnpaired(31, 6)).toBe('auto-paired')
  expect(access.firstPermissionedContact(30)).toBe(5)
  expect(access.firstPermissionedContact(31)).toBe(6)
})

test('auto-pair persists owner so subsequent owner-only-rule check works', () => {
  // Owner 5 paired to chat 10
  access.addChat(10, 5)
  // New group chat 20: owner 5 sends first message → auto-paired
  expect(decideUnpaired(20, 5)).toBe('auto-paired')
  // Now a non-owner message in chat 20 must be filtered by the existing
  // owner-only rule (server.ts lines 636-646). Verify the data is in
  // place for that filter:
  expect(access.firstPermissionedContact(20)).toBe(5)
  // (The actual rule lives in server.ts; here we just confirm the
  // owner field is set so the rule has something to compare against.)
})

test('msg.fromId undefined → pair-flow (does not auto-pair)', () => {
  access.addChat(10, 5)
  expect(decideUnpaired(20, undefined)).toBe('pair-flow')
  expect(access.isAllowed(20)).toBe(false)
})

describe('auto-pair via principal record (#66 Option A)', () => {
  test('contact with only a principal (no chats) auto-pairs on new chat message', () => {
    // Edge case under the new model: a principal can exist without
    // any approved chats (e.g., the user unpaired all their chats but
    // we never wiped the principal — pre-#66-fix behavior). The new
    // gate uses isContactPermissioned, which reads principals first, so
    // they auto-pair on a new chat without ceremony. Matches the
    // "contact identity is the trust boundary" intent.
    access.recordContactPair(access.DEFAULT_AGENT_ID, 5)
    // hasAnyOwner is false (no chat-allowlist entries) — this branch
    // bypasses the stranger-lockout and falls through to the auto-pair.
    expect(decideUnpaired(10, 5)).toBe('auto-paired')
    expect(access.firstPermissionedContact(10)).toBe(5)
  })

  test('contact with chats + principal works the same as chats-only (legacy)', () => {
    access.addChat(10, 5)
    access.recordContactPair(access.DEFAULT_AGENT_ID, 5)
    expect(decideUnpaired(20, 5)).toBe('auto-paired')
    expect(access.firstPermissionedContact(20)).toBe(5)
  })

  test('stranger with no principal and no chats is rejected when other owners exist', () => {
    access.addChat(10, 5)
    access.recordContactPair(access.DEFAULT_AGENT_ID, 5)
    // A new contact (99) with no record on either layer — must be
    // rejected because the bot is no longer in fresh-install mode.
    expect(decideUnpaired(20, 99)).toBe('ignored')
  })

  test('removeContact + removeChat fully revokes — subsequent message is ignored', () => {
    access.addChat(10, 5)
    access.recordContactPair(access.DEFAULT_AGENT_ID, 5)
    expect(access.isContactPermissioned(access.DEFAULT_AGENT_ID, 5)).toBe(true)

    // Mirror the unpair_commit / dc_access_unpair sequence: cleanupChatState
    // runs per-chat (which calls removeChat under the hood), then
    // removeContact wipes the principal.
    access.removeChat(10)
    access.removeContact(access.DEFAULT_AGENT_ID, 5)
    expect(access.isContactPermissioned(access.DEFAULT_AGENT_ID, 5)).toBe(false)

    // Add a different contact's chat so hasAnyOwner is true (otherwise
    // we'd be in fresh-install mode and ANY contact could pair).
    access.addChat(11, 6)
    expect(decideUnpaired(20, 5)).toBe('ignored')
  })

  test('removeContact alone (chats stay) still leaves contact approved via legacy fallback', () => {
    // Documents the legacy-fallback safety: while the principal is
    // gone, isKnownOwner still finds the chat-allowlist entry. The
    // unpair flow removes BOTH layers, so this state isn't reachable
    // through normal use — but if a future migration leaves a chat
    // without its principal, auth keeps working.
    access.addChat(10, 5)
    access.recordContactPair(access.DEFAULT_AGENT_ID, 5)
    access.removeContact(access.DEFAULT_AGENT_ID, 5)
    expect(access.isContactPermissioned(access.DEFAULT_AGENT_ID, 5)).toBe(true)
    expect(decideUnpaired(20, 5)).toBe('auto-paired')
  })
})

describe('auto-pair → principals contract', () => {
  // Phase 2 design: principals are keyed per *contact*, not per chat.
  // The first pair for a contact goes through completePairing() which
  // writes a Contact record.  Auto-pair adds *another chat* for
  // the same contact via addChat() — it does not (and does not need to)
  // touch the principal record, because the contact already has one.
  //
  // This test block pins that contract.  If a future refactor decides
  // addChat() should also write principals, these tests will need to be
  // updated to reflect the new behavior.

  test('addChat (auto-pair primitive) does NOT write a principal directly', () => {
    expect(access.loadContact(access.DEFAULT_AGENT_ID, 5)).toBeNull()
    access.addChat(10, 5) // simulates auto-pair branch
    expect(access.loadContact(access.DEFAULT_AGENT_ID, 5)).toBeNull() // principal still missing
    expect(access.isAllowed(10)).toBe(true) // chat is approved though
  })

  test('completePairing writes principal; subsequent auto-pair re-uses it', () => {
    // First pair via completePairing: principal lands on disk.
    const code = access.startPairing(10, 5)
    access.completePairing(code)
    const first = access.loadContact(access.DEFAULT_AGENT_ID, 5)
    expect(first).not.toBeNull()
    const firstPairedAt = first!.firstPairedAt

    // Same contact auto-pairs into chat 20 (decideUnpaired path).
    expect(decideUnpaired(20, 5)).toBe('auto-paired')

    // Principal record is unchanged — no double-write, firstPairedAt
    // preserved (auto-pair must not bump it).
    const second = access.loadContact(access.DEFAULT_AGENT_ID, 5)
    expect(second).not.toBeNull()
    expect(second!.firstPairedAt).toBe(firstPairedAt)
  })

  test('chatsFor a paired human reflects auto-paired chats', () => {
    // First pair → principal record + chat 10 owned by contact 5.
    access.completePairing(access.startPairing(10, 5))
    // Auto-pair into 20 + 30.
    decideUnpaired(20, 5)
    decideUnpaired(30, 5)
    const human = access.loadContact(access.DEFAULT_AGENT_ID, 5)!
    expect(access.chatsFor(human).sort((a, b) => a - b)).toEqual([10, 20, 30])
  })

  test('backfillFromAllowlist catches contacts paired before Phase 2 (legacy installs)', () => {
    // Simulate a pre-Phase-2 install: chat in allowlist, no principal yet.
    access.addChat(10, 5)
    expect(access.loadContact(access.DEFAULT_AGENT_ID, 5)).toBeNull()

    // Dispatcher startup runs backfill → principal lands on disk.
    expect(access.backfillFromAllowlist(access.DEFAULT_AGENT_ID)).toBe(1)
    expect(access.loadContact(access.DEFAULT_AGENT_ID, 5)).not.toBeNull()

    // Idempotent: re-running backfill is a no-op.
    expect(access.backfillFromAllowlist(access.DEFAULT_AGENT_ID)).toBe(0)
  })

  test('backfill + auto-pair-of-same-contact end up consistent', () => {
    // Legacy install with chat 10 owned by contact 5 (no principal yet).
    access.addChat(10, 5)
    // Startup backfill writes the principal.
    access.backfillFromAllowlist(access.DEFAULT_AGENT_ID)
    const principal = access.loadContact(access.DEFAULT_AGENT_ID, 5)!
    const firstPairedAt = principal.firstPairedAt

    // Now contact 5 auto-pairs into chat 20.
    decideUnpaired(20, 5)

    // Principal is still there, firstPairedAt unchanged, and chatsFor
    // sees both chats.
    const after = access.loadContact(access.DEFAULT_AGENT_ID, 5)!
    expect(after.firstPairedAt).toBe(firstPairedAt)
    expect(access.chatsFor(after).sort((a, b) => a - b)).toEqual([10, 20])
  })

  test('two contacts auto-pairing each get their own principal (after backfill)', () => {
    access.completePairing(access.startPairing(10, 5))
    access.completePairing(access.startPairing(11, 6))
    decideUnpaired(20, 5)
    decideUnpaired(21, 6)

    expect(access.listContacts(access.DEFAULT_AGENT_ID).map((h) => h.contactId).sort()).toEqual([5, 6])
    expect(access.chatsFor(access.loadContact(access.DEFAULT_AGENT_ID, 5)!).sort((a, b) => a - b)).toEqual([10, 20])
    expect(access.chatsFor(access.loadContact(access.DEFAULT_AGENT_ID, 6)!).sort((a, b) => a - b)).toEqual([11, 21])
  })
})

describe('auto-pair gate by role (Phase 4)', () => {
  test('family-member does not auto-pair into a new chat (role-denied)', () => {
    // A subscriber exists (so hasAnyOwner → stranger-lockout is active).
    access.completePairing(access.startPairing(10, 6)) // subscriber 6 → chat 10
    // family-member contact 5: permissioned but lower-trust role
    access.setContactRole(access.DEFAULT_AGENT_ID, 5, 'family-member')
    expect(decideUnpaired(20, 5)).toBe('role-denied')
    expect(access.isAllowed(20)).toBe(false)
  })

  test('guest does not auto-pair (role-denied)', () => {
    access.completePairing(access.startPairing(10, 6))
    access.setContactRole(access.DEFAULT_AGENT_ID, 5, 'guest')
    expect(decideUnpaired(20, 5)).toBe('role-denied')
  })

  test('untrusted-agent does not auto-pair (role-denied)', () => {
    access.completePairing(access.startPairing(10, 6))
    access.setContactRole(access.DEFAULT_AGENT_ID, 5, 'untrusted-agent')
    expect(decideUnpaired(20, 5)).toBe('role-denied')
  })

  test('trusted-agent CAN auto-pair', () => {
    access.completePairing(access.startPairing(10, 6))
    access.setContactRole(access.DEFAULT_AGENT_ID, 5, 'trusted-agent')
    expect(decideUnpaired(20, 5)).toBe('auto-paired')
    expect(access.isAllowed(20)).toBe(true)
  })

  test('subscriber CAN auto-pair (existing behavior preserved)', () => {
    access.completePairing(access.startPairing(10, 6))
    access.recordContactPair(access.DEFAULT_AGENT_ID, 5)
    expect(decideUnpaired(20, 5)).toBe('auto-paired')
    expect(access.isAllowed(20)).toBe(true)
  })

  test('legacy contact (no principal, isKnownOwner via chat-allowlist) CAN auto-pair', () => {
    // Pre-backfill state: chat entry exists but no principal record.
    // loadContact returns null → role treated as subscriber (legacy compat).
    access.addChat(10, 5) // chat-allowlist entry, no principal
    expect(access.loadContact(access.DEFAULT_AGENT_ID, 5)).toBeNull()
    expect(decideUnpaired(20, 5)).toBe('auto-paired')
  })
})
