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
 *   - turn telemetry: emits a TurnTelemetry record when each runNow
 *     completes (see onTurnEvent)
 *
 * The SubagentLike interface exists so the test can substitute a
 * fake that doesn't shell out to claude.
 */

import { randomBytes } from 'node:crypto'
import type { TurnExitReason } from '../events.js'

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
  /** Optional: extend the in-flight turn deadline (used to pause-on-permission). */
  extendDeadline?(extraMs: number): void
}

/**
 * Turn telemetry emitted by the cache on every runNow completion. The
 * cache deliberately ships a minimal record — server.ts enriches it with
 * agentId/sessionId (read from bindings) before handing to logTurn.
 */
export interface TurnTelemetry {
  ts: string
  turnId: string
  chatId: number
  spawnColdMs: number
  durationMs: number
  toolCalls: number
  exitReason: TurnExitReason
}

export interface SubagentCacheOptions {
  maxActive: number
  idleTimeoutMs: number
  spawnFn: (chatId: number) => Promise<SubagentLike | null>
  logf?: (fmt: string, ...args: unknown[]) => void
  /** Per-turn timeout forwarded to SubagentLike.send. */
  turnTimeoutMs?: number
  /** Max queued prompts per chat while a turn is in flight. Defaults to 10. */
  queueMax?: number
  /** Fired when a cached subagent is detected dead between turns or after a send failure. */
  onCrash?: (chatId: number) => void
  /** Fired when a queued prompt is dropped because the per-chat queue is full. */
  onQueueDrop?: (chatId: number) => void
  /** Fired once per runNow completion with turn timing + exit reason. */
  onTurnEvent?: (ev: TurnTelemetry) => void
}

interface CacheEntry {
  sub: SubagentLike
  idleTimer: NodeJS.Timeout | null
  queue: Array<{ text: string; turnId: string; enqueuedAt: number; resolve: (r: unknown) => void; reject: (e: Error) => void }>
  busy: boolean
  /** Ms spent in cold-spawn for this subagent; consumed by the first turn that uses it, then zeroed. */
  spawnColdMs: number
  /** In-flight turn id (set between busy=true and finally). */
  currentTurnId: string | null
  /** In-flight turn tool-call counter. */
  currentTurnToolCalls: number
  /** Set by evict() when the cache tears the sub down; read by runNow's finally to classify the exit. */
  evictReason: 'lru_evict' | 'user_abort' | null
}

const DEFAULT_QUEUE_DEPTH = 10

function genTurnId(): string {
  return randomBytes(6).toString('hex')
}

export class SubagentCache {
  private entries = new Map<number, CacheEntry>()
  /** Ordered by most-recently used; entries[0] is the LRU victim. */
  private lruOrder: number[] = []
  private logf: (fmt: string, ...args: unknown[]) => void
  private queueMax: number

  constructor(private opts: SubagentCacheOptions) {
    this.logf = opts.logf ?? (() => {})
    this.queueMax = Math.max(1, opts.queueMax ?? DEFAULT_QUEUE_DEPTH)
  }

  size(): number { return this.entries.size }

  /** True if a live subagent is already cached for this chat (i.e., next dispatch is warm). */
  hasLive(chatId: number): boolean {
    const e = this.entries.get(chatId)
    return !!(e && e.sub.alive)
  }

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

  private async evict(chatId: number, reason: 'lru_evict' | 'user_abort' = 'user_abort'): Promise<void> {
    const entry = this.entries.get(chatId)
    if (!entry) return
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    // Flag the in-flight turn so runNow's finally classifies the resulting
    // error as lru_evict/user_abort instead of crash. SubagentProcess.close
    // aborts the pending readFrame synchronously, so the send rejects before
    // we even reach the await below.
    if (entry.busy) entry.evictReason = reason
    this.entries.delete(chatId)
    this.lruOrder = this.lruOrder.filter((c) => c !== chatId)
    // Fail queued work — those turns never ran, so we don't emit turn events.
    for (const q of entry.queue) q.reject(new Error('subagent evicted'))
    await entry.sub.close().catch(() => {})
  }

  private async ensureCapacity(): Promise<void> {
    while (this.entries.size >= this.opts.maxActive) {
      const victimId = this.lruOrder[0]
      if (victimId === undefined) return
      this.logf('cache: evicting LRU chat=%d', victimId)
      await this.evict(victimId, 'lru_evict')
    }
  }

  private async spawn(chatId: number): Promise<CacheEntry> {
    await this.ensureCapacity()
    const t0 = Date.now()
    const sub = await this.opts.spawnFn(chatId)
    if (!sub) throw new Error('subagent spawn skipped (no agent bound)')
    const spawnColdMs = Date.now() - t0
    this.logf('cache: cold-spawn chat=%d elapsed=%dms', chatId, spawnColdMs)
    const entry: CacheEntry = {
      sub,
      idleTimer: null,
      queue: [],
      busy: false,
      spawnColdMs,
      currentTurnId: null,
      currentTurnToolCalls: 0,
      evictReason: null,
    }
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
      // Crashed. Remove, notify, and respawn.
      this.logf('cache: detected dead subagent chat=%d, respawning', chatId)
      await this.evict(chatId)
      try { this.opts.onCrash?.(chatId) } catch {}
    }
    return await this.spawn(chatId)
  }

  async dispatch(chatId: number, text: string): Promise<{ text: string; denials: Array<{ tool_name?: string; command?: string }> }> {
    const entry = await this.ensure(chatId)
    const turnId = genTurnId()
    return await this.runOrQueue(entry, chatId, text, turnId)
  }

  /**
   * Return the turnId currently in-flight for `chatId`, bumping a local
   * counter so we know how many tool calls it issued. Returns null when
   * there's no in-flight turn (e.g. a stray tool call arriving between
   * turns, or from a subagent whose entry was evicted). Safe to call from
   * the socket-server request path.
   */
  recordToolCall(chatId: number): string | null {
    const entry = this.entries.get(chatId)
    if (!entry || !entry.busy || !entry.currentTurnId) return null
    entry.currentTurnToolCalls += 1
    return entry.currentTurnId
  }

  /**
   * Spawn (or reuse) a subagent for a chat without sending a turn. Used to
   * pre-warm the subagent at pair time so the user's first message hits a
   * hot process instead of paying the ~10-15s cold-spawn tax on the first
   * chat turn.
   */
  async prewarm(chatId: number): Promise<void> {
    await this.ensure(chatId)
  }

  private runOrQueue(entry: CacheEntry, chatId: number, text: string, turnId: string): Promise<{ text: string; denials: Array<{ tool_name?: string; command?: string }> }> {
    if (entry.busy) {
      if (entry.queue.length >= this.queueMax) {
        const dropped = entry.queue.shift()
        if (dropped) dropped.reject(new Error('dropped: queue overflow'))
        this.logf('cache: queue overflow chat=%d, dropped oldest', chatId)
        try { this.opts.onQueueDrop?.(chatId) } catch {}
      }
      return new Promise((resolve, reject) => {
        entry.queue.push({ text, turnId, enqueuedAt: Date.now(), resolve: resolve as (r: unknown) => void, reject })
      })
    }
    return this.runNow(entry, chatId, text, turnId)
  }

  private async runNow(entry: CacheEntry, chatId: number, text: string, turnId: string): Promise<{ text: string; denials: Array<{ tool_name?: string; command?: string }> }> {
    const turnStart = Date.now()
    const spawnColdMs = entry.spawnColdMs
    entry.spawnColdMs = 0 // consumed by this turn
    entry.busy = true
    entry.currentTurnId = turnId
    entry.currentTurnToolCalls = 0
    let exitReason: TurnExitReason = 'completed'
    try {
      const result = await entry.sub.send(text, this.opts.turnTimeoutMs)
      this.touch(chatId)
      this.resetIdleTimer(chatId)
      return result
    } catch (err) {
      if (entry.evictReason) {
        exitReason = entry.evictReason
      } else if (err instanceof Error && /^timeout after \d+ms/.test(err.message)) {
        exitReason = 'turn_timeout'
      } else if (!entry.sub.alive) {
        exitReason = 'crash'
      } else {
        exitReason = 'crash'
      }
      if (!entry.sub.alive && !entry.evictReason) {
        this.logf('cache: subagent died during send chat=%d', chatId)
        try { this.opts.onCrash?.(chatId) } catch {}
      }
      throw err
    } finally {
      const durationMs = Date.now() - turnStart
      const toolCalls = entry.currentTurnToolCalls
      try {
        this.opts.onTurnEvent?.({
          ts: new Date(turnStart).toISOString(),
          turnId,
          chatId,
          spawnColdMs,
          durationMs,
          toolCalls,
          exitReason,
        })
      } catch {}
      entry.currentTurnId = null
      entry.currentTurnToolCalls = 0
      entry.busy = false
      // Drain one queued message if any
      const next = entry.queue.shift()
      if (next) {
        this.runNow(entry, chatId, next.text, next.turnId).then(next.resolve).catch(next.reject)
      }
    }
  }

  /**
   * Extend the in-flight turn deadline for a chat's subagent. No-op if no
   * subagent is cached or it doesn't support extension.
   */
  extendTurnDeadline(chatId: number, extraMs: number): void {
    const entry = this.entries.get(chatId)
    if (!entry || !entry.busy) return
    entry.sub.extendDeadline?.(extraMs)
  }

  /** Evict one chat's cached subagent (if any). No-op if absent. Public for config-change invalidation. */
  async evictChat(chatId: number): Promise<void> {
    await this.evict(chatId)
  }

  async closeAll(): Promise<void> {
    const chatIds = [...this.entries.keys()]
    for (const id of chatIds) await this.evict(id)
  }
}
