/**
 * Per-chat sliding-window rate limiter for tool-proxy calls.
 *
 * State lives in the dispatcher (not the subagent) so a crash-loop can't
 * refill the bucket by respawning.
 */

export interface RateLimiterOptions {
  /** Max calls per chat per window. */
  limit: number
  /** Window length in milliseconds. */
  windowMs: number
  /** Injectable clock for tests. */
  now?: () => number
}

export class RateLimiter {
  private buckets = new Map<number, number[]>()
  constructor(private opts: RateLimiterOptions) {}

  /** Returns true if the call is allowed; false if the chat is over budget. */
  check(chatId: number): boolean {
    const now = (this.opts.now ?? Date.now)()
    const cutoff = now - this.opts.windowMs
    let arr = this.buckets.get(chatId)
    if (!arr) { arr = []; this.buckets.set(chatId, arr) }
    while (arr.length > 0 && arr[0] < cutoff) arr.shift()
    if (arr.length >= this.opts.limit) return false
    arr.push(now)
    return true
  }

  /** Test/diag helper: current bucket size for a chat. */
  size(chatId: number): number {
    return this.buckets.get(chatId)?.length ?? 0
  }
}
