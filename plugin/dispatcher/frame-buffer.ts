/**
 * Ordered frame buffer for a subagent's stream-json stdout.
 *
 * Extracted from SubagentProcess so the read/buffer/timeout state machine is
 * unit-testable without spawning a real `claude` process (fix-carries-its-seam,
 * #137). One reader at a time (the caller holds a busy lock); frames that
 * arrive with no reader waiting are buffered, and a reader picks the first
 * buffered frame matching its predicate.
 *
 * The off-by-one bug this guards against: a `result` frame left buffered by a
 * prior turn (e.g. a turn that timed out while its process kept running) would
 * be handed to the NEXT turn's read — every reply then lags one message behind.
 * `clearStale()` at each turn boundary drops leftovers so a turn only ever sees
 * its own frames.
 */
export class FrameBuffer<F> {
  private queue: F[] = []
  private waiters: Array<(f: F) => void> = []
  private pendingReject: ((err: Error) => void) | null = null
  private pendingTimer: ReturnType<typeof setTimeout> | null = null
  private pendingDeadline = 0
  private closed = false

  /** Deliver a frame to the waiting reader, or buffer it if none is waiting. */
  push(frame: F): void {
    if (this.waiters.length) this.waiters.shift()!(frame)
    else this.queue.push(frame)
  }

  /**
   * Drop every buffered frame. Called at the start of each turn. The buffer is
   * only ever drained for a turn's result, so anything sitting in it when a new
   * turn begins is a stray/late frame from a PRIOR turn — returning it as this
   * turn's result is the off-by-one bug. Returns the count dropped.
   */
  clearStale(): number {
    const n = this.queue.length
    this.queue.length = 0
    return n
  }

  read(predicate: (f: F) => boolean, timeoutMs: number): Promise<F> {
    for (let i = 0; i < this.queue.length; i++) {
      if (predicate(this.queue[i])) return Promise.resolve(this.queue.splice(i, 1)[0])
    }
    if (this.closed) return Promise.reject(new Error('frame buffer closed'))
    return new Promise<F>((resolve, reject) => {
      this.pendingReject = reject
      this.pendingDeadline = Date.now() + timeoutMs
      const arm = () => {
        const remaining = Math.max(0, this.pendingDeadline - Date.now())
        this.pendingTimer = setTimeout(() => {
          if (Date.now() < this.pendingDeadline) { arm(); return }
          const idx = this.waiters.indexOf(resolveWrapper)
          if (idx >= 0) this.waiters.splice(idx, 1)
          this.pendingTimer = null
          this.pendingReject = null
          reject(new Error(`timeout after ${timeoutMs}ms`))
        }, remaining)
      }
      arm()
      const resolveWrapper = (f: F) => {
        if (!predicate(f)) { this.queue.push(f); this.waiters.push(resolveWrapper); return }
        if (this.pendingTimer) { clearTimeout(this.pendingTimer); this.pendingTimer = null }
        this.pendingReject = null
        resolve(f)
      }
      this.waiters.push(resolveWrapper)
    })
  }

  /** Extend the in-flight read deadline by extraMs (e.g. while paused for a prompt). */
  extendDeadline(extraMs: number): void {
    if (!this.pendingTimer || extraMs <= 0) return
    this.pendingDeadline += extraMs
  }

  /** Reject the in-flight reader (close/exit) so callers unblock immediately. */
  abort(err: Error): void {
    if (this.pendingTimer) { clearTimeout(this.pendingTimer); this.pendingTimer = null }
    this.waiters.length = 0
    const reject = this.pendingReject
    this.pendingReject = null
    if (reject) reject(err)
  }

  /** Mark closed so future reads reject instead of hanging. */
  markClosed(): void {
    this.closed = true
  }
}
