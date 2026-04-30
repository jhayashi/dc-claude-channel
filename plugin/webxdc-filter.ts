/**
 * WebXDC update filtering — centralized owner verification.
 *
 * Group-chat updates can come from any chat member, but only the owner
 * should be allowed to act on bot-sent WebXDC apps (permission prompts,
 * agent-setup confirms, file-reviewer comments, etc.).
 *
 * History note: dc-core ≥ 2.48 returns `webxdc.selfAddr` as a
 * deterministic 64-char hash, NOT the real email. We can't compute the
 * hash from the owner's email (no public dc-core API for it), and
 * `getWebxdcStatusUpdates` doesn't carry sender metadata. So strict
 * lookup-and-compare is impossible — group chats fall back to TOFU.
 *
 * The TOFU contract: in a group chat the FIRST status update we see
 * (per chat) seeds the cache with its `senderAddr` as the trusted
 * owner hash. Subsequent updates with a different hash are rejected.
 * This trades a small race-on-first-interaction risk (a non-owner
 * tapping the WebXDC before the owner does taints the cache and
 * locks the owner out) for unblocking group-chat WebXDC entirely —
 * the previous behavior rejected every update silently.
 *
 * 1:1 chats keep the unconditional fast path: the only non-bot
 * member IS the owner, so any senderAddr is the owner's by
 * construction.
 *
 * Compatibility note for #66 (future principal-keyed access): the
 * cache is keyed by chatId today; that lookup becomes a one-line
 * change to whatever the access layer exposes for "owner contact of
 * this chat" — the TOFU mechanism doesn't need to change.
 */

import type { WebXDCUpdate } from './dc-client.js'

export interface FilterContext {
  owner: number | null
  chatId: number
  msgId: number
  appId: string
  /** Number of contacts in the chat (including the bot self). 2 = 1:1 chat. */
  chatContactCount: number
  logf: (format: string, ...args: unknown[]) => void
}

/**
 * Per-chat learned owner senderAddr (TOFU). Cleared when the chat is
 * unpaired so a re-pair doesn't inherit stale state from a prior owner.
 * One trusted hash per chat — the owner's selfAddr is per-(contact, chat),
 * stable across all WebXDC apps within the chat.
 */
const trustedSenderAddrs = new Map<number, string>()

export function clearTrustedSenderAddrs(chatId: number): void {
  trustedSenderAddrs.delete(chatId)
}

/**
 * Explicit cache seed — sets the trusted owner hash for a chat without
 * waiting for a first incoming update. Reserved for future code that
 * has an out-of-band way to learn the owner's hash (e.g., a signed
 * handshake on the WebXDC's first paint). No production caller today;
 * tests use it to set up a populated cache state.
 */
export function seedTrustedSenderAddr(chatId: number, addr: string): void {
  trustedSenderAddrs.set(chatId, addr)
}

/**
 * Test-only — wipe the entire cache. Lets test files keep using a
 * shared chatId across cases without leaking TOFU state between them.
 */
export function _clearAllTrustedSenderAddrsForTesting(): void {
  trustedSenderAddrs.clear()
}

/**
 * Filter WebXDC updates by owner verification.
 *
 * 1. No owner → pass through (legacy unpaired path).
 * 2. Update lacks senderAddr → reject (cannot be attributed).
 * 3. 1:1 chat (contact count ≤ 2) → trust the senderAddr unconditionally;
 *    the only non-bot member IS the owner.
 * 4. Group chat:
 *    a. Cache hit (senderAddr matches cached owner hash) → accept.
 *    b. Cache miss, no entry yet → TOFU seed + accept.
 *    c. Cache miss, entry exists but doesn't match → reject as non-owner.
 */
export async function filterUpdatesByOwner(
  updates: WebXDCUpdate[],
  fctx: FilterContext,
): Promise<WebXDCUpdate[]> {
  if (!fctx.owner) {
    return updates
  }

  const isOneOnOne = fctx.chatContactCount <= 2

  const filtered: WebXDCUpdate[] = []
  for (const u of updates) {
    const payload = u.payload as { senderAddr?: string } | null
    if (!payload?.senderAddr) {
      fctx.logf('dc channel: rejecting webxdc update without senderAddr in owned chat %d (msg %d, app %s)', fctx.chatId, fctx.msgId, fctx.appId)
      continue
    }

    if (isOneOnOne) {
      filtered.push(u)
      continue
    }

    const trusted = trustedSenderAddrs.get(fctx.chatId)
    if (trusted === undefined) {
      // First update in this chat — TOFU seed.
      trustedSenderAddrs.set(fctx.chatId, payload.senderAddr)
      fctx.logf('dc channel: TOFU-seeded owner hash for chat %d (msg %d, app %s)', fctx.chatId, fctx.msgId, fctx.appId)
      filtered.push(u)
      continue
    }
    if (trusted === payload.senderAddr) {
      filtered.push(u)
      continue
    }
    fctx.logf('dc channel: rejecting webxdc update from non-owner addr in chat %d (msg %d, app %s) — does not match cached owner hash', fctx.chatId, fctx.msgId, fctx.appId)
  }
  return filtered
}
