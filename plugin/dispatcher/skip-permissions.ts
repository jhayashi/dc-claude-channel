/**
 * Skip-permissions short-circuit for the dispatcher's permission handler.
 *
 * When a chat is bound to an agent whose metadata has
 * x-dc-skipPermissions=true, the dispatcher auto-approves the subagent's
 * tool call and writes a `skip_auto` permission-log entry instead of
 * showing the WebXDC permission card. This module is the pure check +
 * log write; the socket-server glue lives in server.ts.
 */

import * as agents from '../agents.js'
import * as bindings from '../bindings.js'
import { buildArgPreview, logPermission } from '../events.js'
import type { ServerMessage } from '../shared/protocol.js'

export interface PermissionRequestLike {
  id: string
  tool?: string
  input?: unknown
}

/**
 * If the chat is bound to a skip-permissions agent, write a `skip_auto`
 * permission-log entry and return an `allow` verdict. Returns null when
 * the caller should fall through to the normal WebXDC prompt path.
 *
 * `now` is injected so tests can pin the timestamp in the log line.
 */
export function tryAutoApprove(
  chatId: number,
  frame: PermissionRequestLike,
  now: () => string = () => new Date().toISOString(),
): ServerMessage | null {
  const resolved = bindings.resolveChat(chatId)
  if (!resolved) return null
  if (!agents.getSkipPermissions(resolved.agent)) return null
  logPermission({
    ts: now(),
    chatId,
    // The permissions-log keeps its historic `agentId` field name on disk
    // for compat with archive readers; v1.4 sources the value from the
    // canonical `name` field.
    agentId: resolved.agent.name,
    tool: frame.tool ?? 'unknown',
    inputPreview: buildArgPreview(
      (frame.input && typeof frame.input === 'object')
        ? (frame.input as Record<string, unknown>)
        : null,
    ),
    verdict: 'allow',
    reason: 'skip_auto',
    timedOut: false,
    durationMs: 0,
  })
  return { kind: 'permissionVerdict', id: frame.id, verdict: 'allow' }
}
