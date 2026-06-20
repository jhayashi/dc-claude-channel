/**
 * Shared teleport-out helpers used by both the monolith agent-setup app
 * (until Phase C removes the duplicate handlers) and the new standalone
 * teleport-app. Extracted here to avoid a circular import between
 * apps/agent-setup-app.ts and apps/teleport-app.ts.
 */

import * as bindings from './bindings.js'
import * as access from './access/index.js'
import * as agents from './agents.js'
import * as resume from './resume.js'
import { join } from 'node:path'
import { homedir } from 'node:os'

/**
 * Function deps for buildTeleportOutList. Takes function deps rather than
 * the full AppContext so the helper is trivially unit-testable without a
 * live DC connection.
 */
export interface TeleportOutListCtx {
  jobCountForChat(chatId: number): number
  sessionLive(sessionPath: string): boolean
  chatNameForId(chatId: number): string | null
}

export interface TeleportOutChat {
  chatId: number
  chatName: string
  agentId: string | null
  agentName: string | null
  lastActiveMs: number | null
  jobCount: number
  isTrusted: boolean
  isLive: boolean
  sessionId: string | null
  workingDir: string | null
}

export function buildTeleportOutList(ctx: TeleportOutListCtx): TeleportOutChat[] {
  const rows: TeleportOutChat[] = []
  for (const b of bindings.listBindings()) {
    if (!access.isAllowed(b.chatId)) continue
    const agent = b.agentId ? agents.getAgent(b.agentId) : null
    const chatName = ctx.chatNameForId(b.chatId) ?? `Chat ${b.chatId}`
    const jobCount = ctx.jobCountForChat(b.chatId)
    let isLive = false
    if (b.sessionId && b.workingDir) {
      const hash = resume.projectHashForCwd(b.workingDir)
      const path = join(homedir(), '.claude', 'projects', hash, `${b.sessionId}.jsonl`)
      isLive = ctx.sessionLive(path)
    }
    rows.push({
      chatId: b.chatId,
      chatName,
      agentId: b.agentId ?? null,
      agentName: agent ? ((agent['x-dc-display-name'] as string | undefined) ?? agent.name) : null,
      lastActiveMs: null,
      jobCount,
      isTrusted: !!agent && agents.getSkipPermissions(agent) === true,
      isLive,
      sessionId: b.sessionId ?? null,
      workingDir: b.workingDir ?? null,
    })
  }
  rows.sort((a, b) => (b.lastActiveMs ?? 0) - (a.lastActiveMs ?? 0) || a.chatId - b.chatId)
  return rows
}
