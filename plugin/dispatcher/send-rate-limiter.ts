/**
 * Client-side outbound send rate limiter.
 *
 * Mirrors the chatmail server's GCRA bucket (10 burst, 60/min by default
 * per chatmaild config) so the dispatcher never submits faster than the
 * server will accept. When the bucket is empty, sends park locally
 * instead of hitting the network and getting 4xx-rejected — the rejected
 * messages would just retry inside DC core, burning more bucket
 * capacity and creating an unrecoverable backlog.
 *
 * Default sizing is conservative (8 burst, 50/min) to leave margin for
 * DC core's internal retries on transient 4xx, which we cannot observe
 * locally.
 *
 * Concurrency: a chained-promise tail serializes acquisitions so callers
 * resolve in FIFO order. Refill is continuous (real-time elapsed since
 * last refill).
 */

export interface RateLimiterDeps {
  /** Burst size (tokens). Clamped to [1, 100]. */
  capacity: number
  /** Sustained refill rate, tokens per second. Clamped to [0.0167, 100]. */
  refillPerSec: number
  /** When false, acquire() resolves immediately. Default true. */
  enabled?: boolean
  /** Debug logging sink. */
  logf?: (msg: string) => void
}

export interface RateLimiter {
  /**
   * Resolve when a token is available and consumed. Caller must invoke
   * the underlying RPC after this resolves; the token is NOT refunded if
   * the RPC fails (the server may have seen the connection regardless).
   */
  acquire(): Promise<void>
  /** Read-only state for diagnostics / dc_status. */
  inspect(): { tokens: number; queued: number; capacity: number; refillPerSec: number }
}

interface Waiter {
  resolve: () => void
}

export function createSendRateLimiter(deps: RateLimiterDeps): RateLimiter {
  const enabled = deps.enabled !== false

  // Clamp config to safe bounds.
  const capacity = Math.max(1, Math.min(100, Math.floor(deps.capacity)))
  const refillPerSec = Math.max(1 / 60, Math.min(100, deps.refillPerSec))
  if (capacity !== deps.capacity || refillPerSec !== deps.refillPerSec) {
    deps.logf?.(
      `rate-limit: clamped config — capacity=${capacity} refillPerSec=${refillPerSec.toFixed(3)}`,
    )
  }

  let tokens = capacity
  let lastRefillMs = Date.now()
  const waiters: Waiter[] = []
  let drainTimer: ReturnType<typeof setTimeout> | null = null
  let parkLogCount = 0

  function refill(): void {
    const now = Date.now()
    const elapsedMs = Math.max(0, now - lastRefillMs)
    tokens = Math.min(capacity, tokens + (elapsedMs / 1000) * refillPerSec)
    lastRefillMs = now
  }

  function drainWaiters(): void {
    drainTimer = null
    refill()
    while (waiters.length > 0 && tokens >= 1) {
      const w = waiters.shift()!
      tokens -= 1
      w.resolve()
    }
    if (waiters.length > 0) {
      const tokensNeeded = 1 - tokens
      const waitMs = Math.max(20, Math.ceil((tokensNeeded / refillPerSec) * 1000))
      drainTimer = setTimeout(drainWaiters, waitMs)
    }
  }

  return {
    acquire(): Promise<void> {
      if (!enabled) return Promise.resolve()
      refill()
      // Fast path: token available AND no one ahead in queue.
      if (tokens >= 1 && waiters.length === 0) {
        tokens -= 1
        return Promise.resolve()
      }
      // Slow path: queue and arm the drain timer.
      return new Promise<void>((resolve) => {
        waiters.push({ resolve })
        if (!drainTimer) {
          parkLogCount += 1
          // Only log occasional parks to avoid re-polluting debug.log.
          if (parkLogCount <= 3 || parkLogCount % 50 === 0) {
            deps.logf?.(
              `rate-limit: parking acquire (tokens=${tokens.toFixed(2)} queued=${waiters.length} parks=${parkLogCount})`,
            )
          }
          drainWaiters()
        }
      })
    },
    inspect() {
      refill()
      return { tokens, queued: waiters.length, capacity, refillPerSec }
    },
  }
}
