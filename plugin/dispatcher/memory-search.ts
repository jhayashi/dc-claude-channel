import type { Message, DCClient } from '../dc-client.js'
import type * as accessNs from '../access/index.js'
import type * as bindingsNs from '../bindings.js'
import { formatHistoryLine } from './trust-filter.js'

export interface MemorySearchDeps {
  client: Pick<DCClient, 'searchMessageIds' | 'getHistoryMessages'>
  bindings: Pick<typeof bindingsNs, 'getBindingAgentId'>
  access: Pick<typeof accessNs, 'isContactTrustedForContent'>
}

export interface MemorySearchOptions {
  chatId: number
  query: string
  /** Max snippets returned. Default 8, capped at 50. */
  limit?: number
  /** Reveal unpermissioned bodies inside data-not-instructions markers. Default false. */
  includeUnpermissioned?: boolean
  /** Scope: default = chatId (this chat); null = global (dc-core caps at 1000). */
  scopeChatId?: number | null
}

export interface MemorySnippet { msgId: number; chatId: number; line: string; permissioned: boolean }
export interface MemorySearchResult {
  snippets: MemorySnippet[]
  revealedUnpermissioned: number
  truncated: boolean
}

const DEFAULT_LIMIT = 8

/**
 * Search a chat's history → trust-filtered snippets. Trust is resolved PER
 * RESULT against that message's own chat-bound agent (Phase 0.2 invariant),
 * so a global search never leaks one chat's content under another's trust.
 * Permissioned content (incl. the owner's own earlier messages) returns clean
 * and actionable; only unpermissioned third-party bodies are redacted unless
 * includeUnpermissioned is set.
 */
export async function searchChatMemory(
  opts: MemorySearchOptions,
  deps: MemorySearchDeps,
): Promise<MemorySearchResult> {
  // Use Number.isFinite, not ??, so a NaN limit (e.g. Number('abc') from the
  // tool layer) falls back to the default instead of collapsing slice(0, NaN) → [].
  const requested = Number(opts.limit)
  const limit = Math.min(Math.max(Number.isFinite(requested) ? requested : DEFAULT_LIMIT, 1), 50)
  const scope = opts.scopeChatId === undefined ? opts.chatId : opts.scopeChatId
  const ids = await deps.client.searchMessageIds(opts.query, scope)
  const truncated = ids.length > limit
  const messages = await deps.client.getHistoryMessages(ids.slice(0, limit))

  const snippets: MemorySnippet[] = []
  let revealedUnpermissioned = 0
  for (const m of messages) {
    const agentId = deps.bindings.getBindingAgentId(m.chatId)
    const r = formatHistoryLine(
      m,
      { isContactTrustedForContent: (cid: number) => deps.access.isContactTrustedForContent(agentId, cid) },
      { includeUnpermissioned: opts.includeUnpermissioned === true },
    )
    if (r.revealedUnpermissioned) revealedUnpermissioned++
    snippets.push({ msgId: m.id, chatId: m.chatId, line: r.line, permissioned: r.permissioned })
  }
  return { snippets, revealedUnpermissioned, truncated }
}
