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
function decideUnpaired(chatId: number, fromId: number | undefined): 'ignored' | 'auto-paired' | 'pair-flow' {
  if (access.isAllowed(chatId)) throw new Error('test setup error: chat is already allowed')
  if (access.hasAnyOwner() && fromId && !access.isKnownOwner(fromId)) {
    return 'ignored'
  }
  if (fromId && access.isKnownOwner(fromId)) {
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
  expect(access.getOwner(20)).toBe(5)
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
  expect(access.getOwner(30)).toBe(5)
  expect(access.getOwner(31)).toBe(6)
})

test('auto-pair persists owner so subsequent owner-only-rule check works', () => {
  // Owner 5 paired to chat 10
  access.addChat(10, 5)
  // New group chat 20: owner 5 sends first message → auto-paired
  expect(decideUnpaired(20, 5)).toBe('auto-paired')
  // Now a non-owner message in chat 20 must be filtered by the existing
  // owner-only rule (server.ts lines 636-646). Verify the data is in
  // place for that filter:
  expect(access.getOwner(20)).toBe(5)
  // (The actual rule lives in server.ts; here we just confirm the
  // owner field is set so the rule has something to compare against.)
})

test('msg.fromId undefined → pair-flow (does not auto-pair)', () => {
  access.addChat(10, 5)
  expect(decideUnpaired(20, undefined)).toBe('pair-flow')
  expect(access.isAllowed(20)).toBe(false)
})

describe('auto-pair → principals contract', () => {
  // Phase 2 design: principals are keyed per *contact*, not per chat.
  // The first pair for a contact goes through completePairing() which
  // writes a HumanPrincipal record.  Auto-pair adds *another chat* for
  // the same contact via addChat() — it does not (and does not need to)
  // touch the principal record, because the contact already has one.
  //
  // This test block pins that contract.  If a future refactor decides
  // addChat() should also write principals, these tests will need to be
  // updated to reflect the new behavior.

  test('addChat (auto-pair primitive) does NOT write a principal directly', () => {
    expect(access.loadHuman(5)).toBeNull()
    access.addChat(10, 5) // simulates auto-pair branch
    expect(access.loadHuman(5)).toBeNull() // principal still missing
    expect(access.isAllowed(10)).toBe(true) // chat is approved though
  })

  test('completePairing writes principal; subsequent auto-pair re-uses it', () => {
    // First pair via completePairing: principal lands on disk.
    const code = access.startPairing(10, 5)
    access.completePairing(code)
    const first = access.loadHuman(5)
    expect(first).not.toBeNull()
    const firstPairedAt = first!.firstPairedAt

    // Same contact auto-pairs into chat 20 (decideUnpaired path).
    expect(decideUnpaired(20, 5)).toBe('auto-paired')

    // Principal record is unchanged — no double-write, firstPairedAt
    // preserved (auto-pair must not bump it).
    const second = access.loadHuman(5)
    expect(second).not.toBeNull()
    expect(second!.firstPairedAt).toBe(firstPairedAt)
  })

  test('chatsFor a paired human reflects auto-paired chats', () => {
    // First pair → principal record + chat 10 owned by contact 5.
    access.completePairing(access.startPairing(10, 5))
    // Auto-pair into 20 + 30.
    decideUnpaired(20, 5)
    decideUnpaired(30, 5)
    const human = access.loadHuman(5)!
    expect(access.chatsFor(human).sort((a, b) => a - b)).toEqual([10, 20, 30])
  })

  test('backfillFromAllowlist catches contacts paired before Phase 2 (legacy installs)', () => {
    // Simulate a pre-Phase-2 install: chat in allowlist, no principal yet.
    access.addChat(10, 5)
    expect(access.loadHuman(5)).toBeNull()

    // Dispatcher startup runs backfill → principal lands on disk.
    expect(access.backfillFromAllowlist()).toBe(1)
    expect(access.loadHuman(5)).not.toBeNull()

    // Idempotent: re-running backfill is a no-op.
    expect(access.backfillFromAllowlist()).toBe(0)
  })

  test('backfill + auto-pair-of-same-contact end up consistent', () => {
    // Legacy install with chat 10 owned by contact 5 (no principal yet).
    access.addChat(10, 5)
    // Startup backfill writes the principal.
    access.backfillFromAllowlist()
    const principal = access.loadHuman(5)!
    const firstPairedAt = principal.firstPairedAt

    // Now contact 5 auto-pairs into chat 20.
    decideUnpaired(20, 5)

    // Principal is still there, firstPairedAt unchanged, and chatsFor
    // sees both chats.
    const after = access.loadHuman(5)!
    expect(after.firstPairedAt).toBe(firstPairedAt)
    expect(access.chatsFor(after).sort((a, b) => a - b)).toEqual([10, 20])
  })

  test('two contacts auto-pairing each get their own principal (after backfill)', () => {
    access.completePairing(access.startPairing(10, 5))
    access.completePairing(access.startPairing(11, 6))
    decideUnpaired(20, 5)
    decideUnpaired(21, 6)

    expect(access.listHumans().map((h) => h.contactId).sort()).toEqual([5, 6])
    expect(access.chatsFor(access.loadHuman(5)!).sort((a, b) => a - b)).toEqual([10, 20])
    expect(access.chatsFor(access.loadHuman(6)!).sort((a, b) => a - b)).toEqual([11, 21])
  })
})
