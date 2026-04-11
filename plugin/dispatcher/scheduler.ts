import { CronExpressionParser } from 'cron-parser'
import type { ScheduledJob, ScheduleStore } from './schedule-store.ts'

// setTimeout's max delay on Node/Bun is (2^31 - 1) ms ≈ 24.8 days.
// If a job is further out than that, arm for the max and rearm on wake.
const MAX_TIMER_MS = 2_147_483_647

export interface SchedulerDeps {
  store: ScheduleStore
  dispatch: (chatId: number, text: string) => Promise<unknown>
  isAllowed: (chatId: number) => boolean
  logf: (fmt: string, ...args: unknown[]) => void
  now?: () => number
  setTimer?: (cb: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

function isExpired(job: ScheduledJob, now: number): boolean {
  if (!job.expiresAt) return false
  return Date.parse(job.expiresAt) <= now
}

export function nextFireAt(job: ScheduledJob, now: number): number | null {
  // One-shot jobs use an explicit targetMs set at creation time.
  if (!job.recurring && job.targetMs !== null) {
    return job.targetMs > now ? job.targetMs : null
  }
  try {
    const iter = CronExpressionParser.parse(job.cron, {
      currentDate: new Date(now),
    })
    return iter.next().toDate().getTime()
  } catch {
    return null
  }
}

export class Scheduler {
  private readonly store: ScheduleStore
  private readonly dispatch: (chatId: number, text: string) => Promise<unknown>
  private readonly isAllowed: (chatId: number) => boolean
  private readonly logf: (fmt: string, ...args: unknown[]) => void
  private readonly now: () => number
  private readonly setTimer: (cb: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private currentTimer: unknown = null
  private started = false
  private firing = false

  constructor(deps: SchedulerDeps) {
    this.store = deps.store
    this.dispatch = deps.dispatch
    this.isAllowed = deps.isAllowed
    this.logf = deps.logf
    this.now = deps.now ?? Date.now
    this.setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms))
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  }

  start(): void {
    this.started = true
    this.rearm()
  }

  stop(): void {
    this.started = false
    if (this.currentTimer !== null) {
      this.clearTimer(this.currentTimer)
      this.currentTimer = null
    }
  }

  add(job: ScheduledJob): void {
    CronExpressionParser.parse(job.cron)
    this.store.save(job)
    this.rearm()
  }

  remove(chatId: number, jobId: string): boolean {
    const existed = this.store.delete(chatId, jobId)
    if (existed) this.rearm()
    return existed
  }

  private rearm(): void {
    if (!this.started) return
    if (this.currentTimer !== null) {
      this.clearTimer(this.currentTimer)
      this.currentTimer = null
    }
    const now = this.now()
    let nearest: number | null = null
    for (const job of this.store.loadAll()) {
      if (isExpired(job, now)) continue
      const nf = nextFireAt(job, now)
      if (nf === null) continue
      if (nearest === null || nf < nearest) nearest = nf
    }
    if (nearest === null) return
    const delay = Math.max(0, nearest - now)
    const armMs = Math.min(delay, MAX_TIMER_MS)
    this.currentTimer = this.setTimer(() => {
      this.currentTimer = null
      if (delay > MAX_TIMER_MS) {
        // Timer overflow: re-arm without firing.
        this.rearm()
        return
      }
      void this.onFire()
    }, armMs)
  }

  private async onFire(): Promise<void> {
    // Replaced in Task 5.
    this.rearm()
  }
}
