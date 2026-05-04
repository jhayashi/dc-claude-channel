/**
 * WebXDC update filtering — minimal pass-through (v1.3.1+).
 *
 * Pre-fix this used per-chat TOFU to trust the FIRST `senderAddr` per
 * chat and reject the rest. In group chats with multiple legitimate
 * devices/members (e.g., Joe-desktop + Joe-iPad), the not-first device
 * was permanently locked out and its updates silently dropped — bug
 * surfaced via resume-import / teleport-out spinners that never
 * cleared in chat 24.
 *
 * v1.3 introduced multi-user dispatch (#70) plus per-tool capability
 * gating (#71). The capability gate (`applyCapabilityGate`) is the
 * security model now: every annotated MCP tool call is gated against
 * the originator's role bundle. The TOFU was a v1.2.2 stopgap from
 * before that gate existed and is now redundant for tool authorization.
 *
 * Caveat: the cap gate covers SUBAGENT MCP tool calls. It does NOT
 * cover dispatcher-internal WebXDC handlers (agent-setup, file-reviewer,
 * permissions). Per-handler cap checks for high-stakes WebXDC actions
 * (assign_role, delete agent, etc.) are tracked as a v1.4 follow-up
 * — apps should resolve `payload.senderAddr → contact → role` and
 * refuse if the role lacks the necessary capability.
 *
 * The remaining defense here: reject updates without a `senderAddr`
 * field as malformed payload guard. Apps that use `senderAddr` for
 * attribution can rely on it being present.
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

export async function filterUpdatesByOwner(
  updates: WebXDCUpdate[],
  fctx: FilterContext,
): Promise<WebXDCUpdate[]> {
  if (!fctx.owner) return updates
  const out: WebXDCUpdate[] = []
  for (const u of updates) {
    const payload = u.payload as { senderAddr?: string } | null
    if (!payload?.senderAddr) {
      fctx.logf('dc channel: rejecting webxdc update without senderAddr in owned chat %d (msg %d, app %s)', fctx.chatId, fctx.msgId, fctx.appId)
      continue
    }
    out.push(u)
  }
  return out
}
