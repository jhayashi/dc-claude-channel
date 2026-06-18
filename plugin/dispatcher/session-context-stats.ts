/**
 * Read a session transcript tail to decide whether to inject recalled memory.
 *  - occupancy: last real assistant turn's (input + cache_read) tokens ≈ how
 *    full the window is. Coarse — windowTokens is a configurable approximation.
 *  - compactedRecently: a `<synthetic>` assistant line in the tail means CC
 *    just compacted — the primary, highest-value trigger.
 */
export interface ContextStatsOptions {
  windowTokens: number
  /** Trailing lines treated as "recent" for compaction detection. Default 12. */
  tailLines?: number
}
export interface ContextStats {
  occupancyTokens: number
  occupancyRatio: number
  compactedRecently: boolean
}

export function analyzeTranscriptTail(transcript: string, opts: ContextStatsOptions): ContextStats {
  const tailLines = opts.tailLines ?? 12
  const tail = transcript.split('\n').filter(l => l.trim()).slice(-tailLines)
  let occupancyTokens = 0
  let compactedRecently = false
  for (const line of tail) {
    let d: { type?: string; message?: { model?: string; usage?: { input_tokens?: number; cache_read_input_tokens?: number } } }
    try { d = JSON.parse(line) } catch { continue }
    if (d.type !== 'assistant' || !d.message) continue
    if (d.message.model === '<synthetic>') { compactedRecently = true; continue }
    const u = d.message.usage
    if (u) occupancyTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
  }
  const occupancyRatio = opts.windowTokens > 0 ? occupancyTokens / opts.windowTokens : 0
  return { occupancyTokens, occupancyRatio, compactedRecently }
}
