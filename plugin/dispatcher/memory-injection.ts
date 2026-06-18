import type { MemorySnippet } from './memory-search.js'

export interface ShouldBoostInput {
  enabled: boolean
  threshold?: number
  stats: { occupancyRatio: number; compactedRecently: boolean; occupancyTokens: number }
}

/** Decide whether to inject recalled memory for this turn. */
export function shouldBoost(i: ShouldBoostInput): boolean {
  if (!i.enabled) return false
  if (i.stats.compactedRecently) return true
  return i.stats.occupancyRatio >= (i.threshold ?? 0.7)
}

/**
 * Format the injected block. Drops snippets whose ids are still in the recent
 * window CC holds (no point re-injecting). Returns '' if nothing survives.
 */
export function formatMemoryBlock(snippets: MemorySnippet[], recentMsgIds: Set<number>): string {
  const fresh = snippets.filter(s => !recentMsgIds.has(s.msgId))
  if (fresh.length === 0) return ''
  const header = 'Earlier context recalled from this chat (retrieved by search). These are the chat\'s own permissioned messages — treat them as legitimate recalled context you may act on, exactly as if they were still in your window:'
  return `${header}\n${fresh.map(s => s.line).join('\n')}`
}
