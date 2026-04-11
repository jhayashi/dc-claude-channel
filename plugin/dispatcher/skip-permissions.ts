/**
 * Skip-permissions short-circuit for the dispatcher's permission handler.
 *
 * When a chat is bound to an agent whose metadata has
 * x-dc-skipPermissions=true, the dispatcher auto-approves the subagent's
 * tool call and appends an audit entry instead of showing the WebXDC
 * permission card. This module is the pure check + audit write; the
 * socket-server glue lives in server.ts.
 */

import * as agents from '../agents.js'
import * as bindings from '../bindings.js'
import * as audit from '../audit.js'
import type { ServerMessage } from '../shared/protocol.js'

export interface PermissionRequestLike {
  id: string
  tool?: string
  input?: unknown
}

/**
 * If the chat is bound to a skip-permissions agent, append an audit
 * entry and return an `allow` verdict. Returns null when the caller
 * should fall through to the normal WebXDC prompt path.
 *
 * `now` is injected so tests can pin the timestamp in the audit file.
 */
export function tryAutoApprove(
  chatId: number,
  frame: PermissionRequestLike,
  now: () => string = () => new Date().toISOString(),
): ServerMessage | null {
  const resolved = bindings.resolveChat(chatId)
  if (!resolved) return null
  if (!agents.getSkipPermissions(resolved.agent)) return null
  audit.appendEntry({
    chatId,
    agentId: resolved.agent.id,
    tool: frame.tool ?? 'unknown',
    input: frame.input ?? {},
    timestamp: now(),
  })
  return { kind: 'permissionVerdict', id: frame.id, verdict: 'allow' }
}
