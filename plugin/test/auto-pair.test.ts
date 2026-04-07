/**
 * Tests for v0.8.3 auto-pair behavior.
 *
 * The actual branch lives in server.ts inside onIncomingMessage. These
 * tests exercise the same access.ts primitives in the same order to
 * verify the decision logic and persistence.
 */

import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as access from '../access.js'

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'dc-autopair-'))
  access.setApprovedDir(tmpDir)
})

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
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
