/**
 * WebXDC update filtering — centralized owner verification.
 *
 * Extracts the filtering logic from server.ts into a pure, testable function.
 * In owned chats, only updates with a valid senderAddr matching the chat owner
 * are forwarded to apps. Updates without senderAddr or from non-owners are rejected.
 * In chats with no owner (legacy), all updates pass through.
 */

import type { WebXDCUpdate } from './dc-client.js'

export interface FilterContext {
  owner: number | null
  chatId: number
  msgId: number
  appId: string
  lookupContactByAddr: (addr: string) => Promise<number | null>
  logf: (format: string, ...args: unknown[]) => void
}

/**
 * Filter WebXDC updates by owner verification.
 *
 * - If no owner is set (legacy chat): all updates pass through.
 * - If owner is set: only updates with senderAddr resolving to the owner's
 *   contact ID are forwarded. Updates without senderAddr or from non-owners
 *   are rejected with a log message.
 */
export async function filterUpdatesByOwner(
  updates: WebXDCUpdate[],
  fctx: FilterContext,
): Promise<WebXDCUpdate[]> {
  if (!fctx.owner) {
    return updates
  }

  const filtered: WebXDCUpdate[] = []
  for (const u of updates) {
    const payload = u.payload as { senderAddr?: string } | null
    if (!payload?.senderAddr) {
      fctx.logf('dc channel: rejecting webxdc update without senderAddr in owned chat %d (msg %d, app %s)', fctx.chatId, fctx.msgId, fctx.appId)
      continue
    }
    const contactId = await fctx.lookupContactByAddr(payload.senderAddr)
    if (contactId !== fctx.owner) {
      fctx.logf('dc channel: rejecting webxdc update from non-owner %s (contact %s) in chat %d (app %s)', payload.senderAddr, contactId ?? 'unknown', fctx.chatId, fctx.appId)
      continue
    }
    filtered.push(u)
  }
  return filtered
}
