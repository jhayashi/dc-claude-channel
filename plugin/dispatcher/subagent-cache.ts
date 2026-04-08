/**
 * LRU cache of persistent subagents, one per chat.
 *
 * Abstracts the per-chat process lifecycle so the rest of the
 * dispatcher only sees `cache.dispatch(chatId, text)` and gets back
 * a TurnResult. Handles:
 *
 *   - spawn-on-demand
 *   - LRU eviction when at DC_SUBAGENT_MAX_ACTIVE
 *   - per-chat idle timeout → close
 *   - crash recovery (if a subagent dies between turns, next
 *     dispatch re-spawns)
 *   - per-chat queue depth of 10 (overflow drops oldest)
 *
 * The SubagentLike interface exists so the test can substitute a
 * fake that doesn't shell out to claude.
 */

export interface SubagentLike {
  readonly chatId: number
  readonly subagentId: string
  readonly alive: boolean
  lastUsed: number
  send(text: string, turnTimeoutMs?: number): Promise<{
    text: string
    denials: Array<{ tool_name?: string; command?: string }>
  }>
  close(): Promise<void>
}

export interface SubagentCacheOptions {
  maxActive: number
  idleTimeoutMs: number
  spawnFn: (chatId: number) => Promise<SubagentLike>
  logf?: (fmt: string, ...args: unknown[]) => void
}

interface CacheEntry {
  sub: SubagentLike
  idleTimer: NodeJS.Timeout | null
  queue: Array<{ text: string; resolve: (r: unknown) => void; reject: (e: Error) => void }>
  busy: boolean
}

const MAX_QUEUE_DEPTH = 10

export class SubagentCache {
  private entries = new Map<number, CacheEntry>()
  /** Ordered by most-recently used; entries[0] is the LRU victim. */
  private lruOrder: number[] = []
  private logf: (fmt: string, ...args: unknown[]) => void

  constructor(private opts: SubagentCacheOptions) {
    this.logf = opts.logf ?? (() => {})
  }

  size(): number { return this.entries.size }

  private touch(chatId: number): void {
    const idx = this.lruOrder.indexOf(chatId)
    if (idx >= 0) this.lruOrder.splice(idx, 1)
    this.lruOrder.push(chatId)
  }

  private resetIdleTimer(chatId: number): void {
    const entry = this.entries.get(chatId)
    if (!entry) return
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    entry.idleTimer = setTimeout(() => {
      this.logf('cache: idle timeout chat=%d', chatId)
      this.evict(chatId).catch(() => {})
    }, this.opts.idleTimeoutMs)
  }

  private async evict(chatId: number): Promise<void> {
    const entry = this.entries.get(chatId)
    if (!entry) return
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    this.entries.delete(chatId)
    this.lruOrder = this.lruOrder.filter((c) => c !== chatId)
    // Fail any queued work
    for (const q of entry.queue) q.reject(new Error('subagent evicted'))
    await entry.sub.close().catch(() => {})
  }

  private async ensureCapacity(): Promise<void> {
    while (this.entries.size >= this.opts.maxActive) {
      const victimId = this.lruOrder[0]
      if (victimId === undefined) return
      this.logf('cache: evicting LRU chat=%d', victimId)
      await this.evict(victimId)
    }
  }

  private async spawn(chatId: number): Promise<CacheEntry> {
    await this.ensureCapacity()
    const sub = await this.opts.spawnFn(chatId)
    const entry: CacheEntry = { sub, idleTimer: null, queue: [], busy: false }
    this.entries.set(chatId, entry)
    this.touch(chatId)
    this.resetIdleTimer(chatId)
    return entry
  }

  private async ensure(chatId: number): Promise<CacheEntry> {
    const existing = this.entries.get(chatId)
    if (existing && existing.sub.alive) {
      this.touch(chatId)
      this.resetIdleTimer(chatId)
      return existing
    }
    if (existing && !existing.sub.alive) {
      // Crashed. Remove and respawn.
      await this.evict(chatId)
    }
    return await this.spawn(chatId)
  }

  async dispatch(chatId: number, text: string): Promise<{ text: string; denials: Array<{ tool_name?: string; command?: string }> }> {
    const entry = await this.ensure(chatId)
    return await this.runOrQueue(entry, chatId, text)
  }

  private runOrQueue(entry: CacheEntry, chatId: number, text: string): Promise<{ text: string; denials: Array<{ tool_name?: string; command?: string }> }> {
    if (entry.busy) {
      if (entry.queue.length >= MAX_QUEUE_DEPTH) {
        const dropped = entry.queue.shift()
        if (dropped) dropped.reject(new Error('dropped: queue overflow'))
      }
      return new Promise((resolve, reject) => {
        entry.queue.push({ text, resolve: resolve as (r: unknown) => void, reject })
      })
    }
    return this.runNow(entry, chatId, text)
  }

  private async runNow(entry: CacheEntry, chatId: number, text: string): Promise<{ text: string; denials: Array<{ tool_name?: string; command?: string }> }> {
    entry.busy = true
    try {
      const result = await entry.sub.send(text)
      this.touch(chatId)
      this.resetIdleTimer(chatId)
      return result
    } finally {
      entry.busy = false
      // Drain one queued message if any
      const next = entry.queue.shift()
      if (next) {
        this.runNow(entry, chatId, next.text).then(next.resolve).catch(next.reject)
      }
    }
  }

  async closeAll(): Promise<void> {
    const chatIds = [...this.entries.keys()]
    for (const id of chatIds) await this.evict(id)
  }
}
