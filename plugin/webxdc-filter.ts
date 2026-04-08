/**
 * WebXDC update filtering — centralized owner verification.
 *
 * Extracts the filtering logic from server.ts into a pure, testable function.
 * In group chats with an owner, only updates with a valid senderAddr matching
 * the chat owner are forwarded to apps. In 1:1 owned chats, the only possible
 * non-bot sender IS the owner, so verification is skipped. In chats with no
 * owner (legacy), all updates pass through.
 *
 * History note: dc-core ≥ 2.48 returns `webxdc.selfAddr` as a deterministic
 * 64-char hash rather than a real email, so `lookupContactByAddr(hash)` always
 * returns null. The strict per-contact match below would reject every update
 * from a real user. The 1:1 fast path makes the common case work; for groups
 * we still attempt the strict check and fall back to TOFU.
 */

import type { WebXDCUpdate } from './dc-client.js'

export interface FilterContext {
  owner: number | null
  chatId: number
  msgId: number
  appId: string
  /** Number of contacts in the chat (including the bot self). 2 = 1:1 chat. */
  chatContactCount: number
  lookupContactByAddr: (addr: string) => Promise<number | null>
  logf: (format: string, ...args: unknown[]) => void
}

/** Per-chat learned senderAddr (TOFU). Cleared when the chat is unpaired. */
const trustedSenderAddrs = new Map<number, Set<string>>()

export function clearTrustedSenderAddrs(chatId: number): void {
  trustedSenderAddrs.delete(chatId)
}

/**
 * Filter WebXDC updates by owner verification.
 *
 * 1. No owner → pass through (legacy unpaired path).
 * 2. 1:1 chat (contact count == 2) → trust the senderAddr unconditionally;
 *    the only non-bot member IS the owner.
 * 3. Group chat → verify via lookupContactByAddr OR via TOFU-learned addr.
 *    Updates without senderAddr are still rejected because they cannot be
 *    attributed.
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
      // 1:1 chat — only the owner can send updates. Trust unconditionally.
      filtered.push(u)
      continue
    }

    // Group chat: try the strict check first.
    const contactId = await fctx.lookupContactByAddr(payload.senderAddr)
    if (contactId === fctx.owner) {
      // Strict match — also TOFU-cache for next time.
      let cache = trustedSenderAddrs.get(fctx.chatId)
      if (!cache) { cache = new Set(); trustedSenderAddrs.set(fctx.chatId, cache) }
      cache.add(payload.senderAddr)
      filtered.push(u)
      continue
    }

    // Strict failed. Try the TOFU cache (anonymized addr learned earlier).
    if (trustedSenderAddrs.get(fctx.chatId)?.has(payload.senderAddr)) {
      filtered.push(u)
      continue
    }

    fctx.logf('dc channel: rejecting webxdc update from non-owner %s (contact %s) in chat %d (app %s)', payload.senderAddr, contactId ?? 'unknown', fctx.chatId, fctx.appId)
  }
  return filtered
}
