import { CronExpressionParser } from 'cron-parser'
import type { ScheduledJob, ScheduleStore } from './schedule-store.ts'

// setTimeout's max delay on Node/Bun is (2^31 - 1) ms ≈ 24.8 days.
// If a job is further out than that, arm for the max and rearm on wake.
const MAX_TIMER_MS = 2_147_483_647

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Count how many times a cron expression would fire in the 7 days after
 * `now`. Used for the `dc_schedule` soft-warn threshold (> 30 triggers a
 * warning in the tool response). Throws if the cron is unparseable.
 */
export function countFiresIn7Days(cron: string, now: number): number {
  const end = now + ONE_WEEK_MS
  const iter = CronExpressionParser.parse(cron, {
    currentDate: new Date(now),
    endDate: new Date(end),
  })
  let count = 0
  // Cap at 10_000 to defend against pathological expressions.
  while (count < 10_000) {
    try {
      iter.next()
      count += 1
    } catch {
      break
    }
  }
  return count
}

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
  private armedFor: number | null = null
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
    this.reapStaleOnStartup()
    this.rearm()
  }

  /**
   * On startup: drop expired recurring jobs (explicit expiresAt in the
   * past) and past-due one-shots (targetMs in the past). Matches the
   * "skip everything missed, don't catch up" policy.
   */
  private reapStaleOnStartup(): void {
    const now = this.now()
    for (const job of this.store.loadAll()) {
      if (isExpired(job, now)) {
        this.logf(
          'scheduler: dropping expired job %s chat=%d',
          job.jobId, job.chatId,
        )
        this.store.delete(job.chatId, job.jobId)
        continue
      }
      if (!job.recurring && job.targetMs !== null && job.targetMs <= now) {
        this.logf(
          'scheduler: dropped stale one-shot job=%s chat=%d (target was %s)',
          job.jobId, job.chatId, new Date(job.targetMs).toISOString(),
        )
        this.store.delete(job.chatId, job.jobId)
      }
    }
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

  /** Force a rearm — used by cleanupChat after an out-of-band store mutation. */
  refresh(): void {
    this.rearm()
  }

  private rearm(): void {
    if (!this.started) return
    if (this.currentTimer !== null) {
      this.clearTimer(this.currentTimer)
      this.currentTimer = null
    }
    this.armedFor = null
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
    const armedFor = nearest
    this.armedFor = armedFor
    this.currentTimer = this.setTimer(() => {
      this.currentTimer = null
      if (delay > MAX_TIMER_MS) {
        // Timer overflow: re-arm without firing.
        this.armedFor = null
        this.rearm()
        return
      }
      void this.onFire(armedFor)
    }, armMs)
  }

  private async onFire(armedFor: number): Promise<void> {
    if (this.firing) {
      this.rearm()
      return
    }
    this.firing = true
    try {
      const now = this.now()
      // Use (armedFor - 1) as the lookup cursor so cron expressions that
      // resolve to exactly `armedFor` are included. For one-shot jobs the
      // targetMs-based nextFireAt also returns the target as long as it's
      // strictly > cursor.
      const cursor = armedFor - 1
      const jobs = this.store.loadAll()
      const due: Array<{ job: ScheduledJob; fireAt: number }> = []
      for (const job of jobs) {
        if (isExpired(job, now)) {
          this.store.delete(job.chatId, job.jobId)
          continue
        }
        const nf = nextFireAt(job, cursor)
        if (nf === null) continue
        if (nf <= armedFor) due.push({ job, fireAt: nf })
      }
      due.sort((a, b) => a.fireAt - b.fireAt)

      for (const { job } of due) {
        // Re-check existence in case a delete landed mid-sweep.
        const stillThere = this.store
          .loadForChat(job.chatId)
          .find(j => j.jobId === job.jobId)
        if (!stillThere) continue

        if (!this.isAllowed(job.chatId)) {
          this.logf(
            'scheduler: dropping job %s for unauthorized chat %d',
            job.jobId, job.chatId,
          )
          this.store.delete(job.chatId, job.jobId)
          continue
        }

        const text =
          `[dc chat_id=${job.chatId} event=scheduled job=${job.jobId}]\n${job.prompt}`
        try {
          await this.dispatch(job.chatId, text)
        } catch (err) {
          this.logf(
            'scheduler: dispatch failed for job %s chat %d: %v',
            job.jobId, job.chatId, err,
          )
          // Fall through — still update lastFiredAt / delete one-shot so
          // we don't hot-loop on a broken job.
        }

        if (job.recurring) {
          const updated: ScheduledJob = {
            ...job,
            lastFiredAt: new Date(now).toISOString(),
          }
          if (isExpired(updated, now)) {
            this.store.delete(job.chatId, job.jobId)
          } else {
            this.store.save(updated)
          }
        } else {
          this.store.delete(job.chatId, job.jobId)
        }
      }
    } finally {
      this.firing = false
      this.rearm()
    }
  }
}
