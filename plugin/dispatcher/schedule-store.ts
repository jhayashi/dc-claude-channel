import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

export interface ScheduledJob {
  jobId:       string
  chatId:      number
  cron:        string
  prompt:      string
  recurring:   boolean
  createdAt:   string
  expiresAt:   string | null
  lastFiredAt: string | null
  // One-shot only: the exact epoch ms when the job should fire, set at
  // creation time. Null for recurring. Used by the startup skip-missed
  // policy to detect past-due one-shots without depending on cron-parser
  // quirks for date-specific expressions.
  targetMs:    number | null
}

export class ScheduleStore {
  constructor(private readonly dir: string) {}

  private filename(chatId: number, jobId: string): string {
    return join(this.dir, `${chatId}-${jobId}.json`)
  }

  private ensureDir(): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
  }

  save(job: ScheduledJob): void {
    this.ensureDir()
    const path = this.filename(job.chatId, job.jobId)
    // Include a PID + UUID suffix so concurrent writes don't collide on
    // the tmp path (previously: last writer silently clobbered the first).
    const tmp = `${path}.tmp.${process.pid}.${crypto.randomUUID().slice(0, 8)}`
    writeFileSync(tmp, JSON.stringify(job, null, 2))
    renameSync(tmp, path)
  }

  loadAll(): ScheduledJob[] {
    if (!existsSync(this.dir)) return []
    const out: ScheduledJob[] = []
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue
      try {
        const raw = readFileSync(join(this.dir, name), 'utf-8')
        out.push(JSON.parse(raw) as ScheduledJob)
      } catch {
        // Corrupt file — skip. Caller logs.
      }
    }
    return out
  }

  loadForChat(chatId: number): ScheduledJob[] {
    return this.loadAll().filter(j => j.chatId === chatId)
  }

  countForChat(chatId: number): number {
    return this.loadForChat(chatId).length
  }

  delete(chatId: number, jobId: string): boolean {
    const path = this.filename(chatId, jobId)
    if (!existsSync(path)) return false
    unlinkSync(path)
    return true
  }

  deleteForChat(chatId: number): number {
    if (!existsSync(this.dir)) return 0
    let n = 0
    const prefix = `${chatId}-`
    for (const name of readdirSync(this.dir)) {
      if (name.startsWith(prefix) && name.endsWith('.json')) {
        unlinkSync(join(this.dir, name))
        n += 1
      }
    }
    return n
  }

  /**
   * Rename every job file from `${fromChatId}-*.json` to
   * `${toChatId}-*.json`, rewriting the `chatId` field inside each
   * file. Used by the send-to-terminal flow when the user opts to
   * preserve scheduled jobs on another chat.
   *
   * Returns the number of files moved. No-op when from === to or
   * when the source chat has no jobs.
   *
   * Throws (before touching disk) if any destination path already
   * exists — refuse to clobber a jobId collision so no schedule
   * silently disappears.
   */
  moveForChat(fromChatId: number, toChatId: number): number {
    if (fromChatId === toChatId) return 0
    if (!existsSync(this.dir)) return 0

    const srcPrefix = `${fromChatId}-`
    const pending: Array<{ src: string; dst: string }> = []
    for (const name of readdirSync(this.dir)) {
      if (!name.startsWith(srcPrefix) || !name.endsWith('.json')) continue
      const jobId = name.slice(srcPrefix.length, -'.json'.length)
      const src = join(this.dir, name)
      const dst = this.filename(toChatId, jobId)
      if (existsSync(dst)) {
        throw new Error(`moveForChat: job-id collision at ${dst} (source ${src})`)
      }
      pending.push({ src, dst })
    }
    if (pending.length === 0) return 0

    for (const { src, dst } of pending) {
      const raw = readFileSync(src, 'utf-8')
      const job = JSON.parse(raw) as ScheduledJob
      job.chatId = toChatId
      const tmp = `${dst}.tmp`
      writeFileSync(tmp, JSON.stringify(job, null, 2))
      renameSync(tmp, dst)
      unlinkSync(src)
    }
    return pending.length
  }
}
