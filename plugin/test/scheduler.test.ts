import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScheduleStore, type ScheduledJob } from '../dispatcher/schedule-store.ts'
import { Scheduler } from '../dispatcher/scheduler.ts'

interface FakeTimer {
  cb: () => void
  ms: number
  fired: boolean
  cancelled: boolean
}

interface Harness {
  store: ScheduleStore
  scheduler: Scheduler
  timers: FakeTimer[]
  dispatched: Array<{ chatId: number; text: string }>
  logs: string[]
  setClock: (iso: string) => void
  fireLatest: () => Promise<void>
  allowed: Set<number>
}

const afterEachCleanup: Array<() => void> = []
afterEach(() => {
  while (afterEachCleanup.length) afterEachCleanup.pop()!()
})

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'dc-scheduler-'))
  const store = new ScheduleStore(dir)
  const timers: FakeTimer[] = []
  const dispatched: Array<{ chatId: number; text: string }> = []
  const logs: string[] = []
  const allowed = new Set<number>([10, 20, 22])
  let nowMs = Date.parse('2026-04-13T09:00:00Z')
  const scheduler = new Scheduler({
    store,
    dispatch: async (chatId, text) => { dispatched.push({ chatId, text }) },
    isAllowed: (id) => allowed.has(id),
    logf: (fmt, ...args) => { logs.push(`${fmt} ${args.join(' ')}`) },
    now: () => nowMs,
    setTimer: (cb, ms) => {
      const t: FakeTimer = { cb, ms, fired: false, cancelled: false }
      timers.push(t)
      return t
    },
    clearTimer: (h) => { (h as FakeTimer).cancelled = true },
  })
  const harness: Harness = {
    store,
    scheduler,
    timers,
    dispatched,
    logs,
    allowed,
    setClock: (iso: string) => { nowMs = Date.parse(iso) },
    fireLatest: async () => {
      for (let i = timers.length - 1; i >= 0; i--) {
        const t = timers[i]
        if (!t.fired && !t.cancelled) {
          t.fired = true
          t.cb()
          break
        }
      }
      await new Promise((r) => setTimeout(r, 0))
    },
  }
  afterEachCleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return harness
}

function fixture(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    jobId: 'aaa111',
    chatId: 22,
    cron: '0 9 * * 1-5',
    prompt: 'morning standup',
    recurring: true,
    createdAt: '2026-04-11T10:00:00.000Z',
    expiresAt: null,
    lastFiredAt: null,
    targetMs: null,
    ...overrides,
  }
}

describe('Scheduler arm/rearm', () => {
  test('start() with no jobs arms no timer', () => {
    const h = makeHarness()
    h.scheduler.start()
    expect(h.timers.filter(t => !t.cancelled).length).toBe(0)
  })

  test('start() with one future job arms one timer for the nearest fire', () => {
    const h = makeHarness()
    // Clock is 2026-04-13 (Monday) 09:00Z. Next fire for "every weekday 09:00Z"
    // is 2026-04-14 09:00Z. That's ~24h away.
    h.setClock('2026-04-13T09:00:01Z')
    h.store.save(fixture())
    h.scheduler.start()
    const live = h.timers.filter(t => !t.cancelled)
    expect(live.length).toBe(1)
    // Within 2s of 86399s.
    expect(Math.abs(live[0].ms - 86_399_000)).toBeLessThan(2000)
  })

  test('add() of a nearer job cancels the old timer and arms a new one', () => {
    const h = makeHarness()
    h.setClock('2026-04-13T09:00:01Z')
    h.store.save(fixture({ jobId: 'far111', cron: '0 9 * * 1-5' })) // ~24h
    h.scheduler.start()
    const firstTimer = h.timers[h.timers.length - 1]
    expect(firstTimer.cancelled).toBe(false)

    h.scheduler.add(fixture({ jobId: 'near22', cron: '* * * * *' }))
    expect(firstTimer.cancelled).toBe(true)
    const newTimer = h.timers[h.timers.length - 1]
    expect(newTimer.cancelled).toBe(false)
    expect(newTimer.ms).toBeLessThan(65_000)
  })

  test('remove() of the nearest job rearms to the next nearest', () => {
    const h = makeHarness()
    h.setClock('2026-04-13T09:00:01Z')
    h.store.save(fixture({ jobId: 'near22', cron: '* * * * *' })) // ~1 min
    h.store.save(fixture({ jobId: 'far111', cron: '0 9 * * 1-5' })) // ~24h
    h.scheduler.start()
    const beforeTimer = h.timers[h.timers.length - 1]
    expect(beforeTimer.ms).toBeLessThan(65_000)
    h.scheduler.remove(22, 'near22')
    const afterTimer = h.timers[h.timers.length - 1]
    expect(afterTimer.cancelled).toBe(false)
    expect(afterTimer.ms).toBeGreaterThan(80_000_000) // ~24h
  })

  test('stop() cancels the active timer', () => {
    const h = makeHarness()
    h.setClock('2026-04-13T09:00:01Z')
    h.store.save(fixture())
    h.scheduler.start()
    h.scheduler.stop()
    const live = h.timers.filter(t => !t.cancelled)
    expect(live.length).toBe(0)
  })

  test('add() rejects an invalid cron expression', () => {
    const h = makeHarness()
    h.scheduler.start()
    expect(() => h.scheduler.add(fixture({ cron: 'not a cron' }))).toThrow()
  })
})

describe('Scheduler fire handler', () => {
  test('recurring job fires, re-saves with lastFiredAt, and rearms', async () => {
    const h = makeHarness()
    h.setClock('2026-04-13T08:59:59Z')
    h.store.save(fixture({ jobId: 'tick11', cron: '* * * * *' }))
    h.scheduler.start()
    h.setClock('2026-04-13T09:00:00.500Z')
    await h.fireLatest()
    expect(h.dispatched.length).toBe(1)
    expect(h.dispatched[0].chatId).toBe(22)
    expect(h.dispatched[0].text).toContain('event=scheduled')
    expect(h.dispatched[0].text).toContain('job=tick11')
    expect(h.dispatched[0].text).toContain('morning standup')
    const stored = h.store.loadForChat(22)
    expect(stored.length).toBe(1)
    expect(stored[0].lastFiredAt).toBeTruthy()
  })

  test('one-shot job is deleted after fire', async () => {
    const h = makeHarness()
    h.setClock('2026-04-13T08:59:59Z')
    h.store.save(fixture({
      jobId: 'once11',
      cron: '* * * * *',
      recurring: false,
      targetMs: Date.parse('2026-04-13T09:00:00Z'),
    }))
    h.scheduler.start()
    h.setClock('2026-04-13T09:00:00.500Z')
    await h.fireLatest()
    expect(h.dispatched.length).toBe(1)
    expect(h.store.countForChat(22)).toBe(0)
  })

  test('unauthorized chat: job GC and no dispatch', async () => {
    const h = makeHarness()
    h.setClock('2026-04-13T08:59:59Z')
    h.allowed.delete(22)
    h.store.save(fixture({ jobId: 'gc1111', cron: '* * * * *' }))
    h.scheduler.start()
    h.setClock('2026-04-13T09:00:00.500Z')
    await h.fireLatest()
    expect(h.dispatched.length).toBe(0)
    expect(h.store.countForChat(22)).toBe(0)
  })

  test('expired recurring job: deleted at fire, no dispatch', async () => {
    const h = makeHarness()
    h.setClock('2026-04-13T08:59:59Z')
    h.store.save(fixture({
      jobId: 'exp111',
      cron: '* * * * *',
      expiresAt: '2026-04-13T08:59:00Z',
    }))
    h.scheduler.start()
    // rearm() skips expired jobs, so no timer is armed.
    const live = h.timers.filter(t => !t.cancelled)
    expect(live.length).toBe(0)
    expect(h.dispatched.length).toBe(0)
  })

  test('two jobs due at the same tick fire sequentially', async () => {
    const h = makeHarness()
    h.setClock('2026-04-13T08:59:59Z')
    h.store.save(fixture({ jobId: 'aaa111', cron: '* * * * *' }))
    h.store.save(fixture({ jobId: 'bbb222', cron: '* * * * *' }))
    h.scheduler.start()
    h.setClock('2026-04-13T09:00:00.500Z')
    await h.fireLatest()
    expect(h.dispatched.length).toBe(2)
  })
})

describe('Scheduler startup skip-missed policy', () => {
  test('recurring: start() uses cron.next(now), so missed fires are skipped for free', () => {
    const h = makeHarness()
    // Clock is 10:00:30Z. A daily 09:00Z job would have fired today at
    // 09:00Z if we'd been up — we do NOT catch up.
    h.setClock('2026-04-13T10:00:30Z')
    h.store.save(fixture({
      jobId: 'skip11',
      cron: '0 9 * * *',
      lastFiredAt: null,
    }))
    h.scheduler.start()
    const live = h.timers.filter(t => !t.cancelled)
    expect(live.length).toBe(1)
    // ~(24h - 1h - 30s) away = 82770s = 82_770_000 ms.
    expect(live[0].ms).toBeGreaterThan(82_000_000)
    expect(live[0].ms).toBeLessThan(83_000_000)
    expect(h.dispatched.length).toBe(0)
  })

  test('past-due one-shot: silently deleted at start() with a log line', () => {
    const h = makeHarness()
    h.setClock('2026-04-13T10:00:30Z')
    h.store.save(fixture({
      jobId: 'gone11',
      cron: '0 9 * * *',
      recurring: false,
      targetMs: Date.parse('2026-04-12T09:00:00Z'), // yesterday
    }))
    h.scheduler.start()
    expect(h.store.countForChat(22)).toBe(0)
    expect(h.logs.some(l => l.includes('dropped stale one-shot'))).toBe(true)
    const live = h.timers.filter(t => !t.cancelled)
    expect(live.length).toBe(0)
  })

  test("expired recurring jobs are GC'd at start()", () => {
    const h = makeHarness()
    h.setClock('2026-04-13T10:00:30Z')
    h.store.save(fixture({
      jobId: 'dead11',
      cron: '* * * * *',
      expiresAt: '2026-04-13T09:00:00Z',
    }))
    h.scheduler.start()
    expect(h.store.countForChat(22)).toBe(0)
  })
})

describe('Scheduler timer overflow', () => {
  test('nearest fire beyond 24d: arm for MAX_TIMER_MS and rearm on wake', async () => {
    const h = makeHarness()
    h.setClock('2026-04-13T09:00:00Z')
    // Yearly on Jan 1 00:00Z — ~9 months away, far beyond MAX_TIMER_MS.
    h.store.save(fixture({ jobId: 'year11', cron: '0 0 1 1 *' }))
    h.scheduler.start()
    const live = h.timers.filter(t => !t.cancelled)
    expect(live.length).toBe(1)
    expect(live[0].ms).toBe(2_147_483_647)

    // Fire it — the handler should detect overflow and rearm without dispatch.
    await h.fireLatest()
    expect(h.dispatched.length).toBe(0)
    const liveAfter = h.timers.filter(t => !t.cancelled && !t.fired)
    expect(liveAfter.length).toBe(1)
  })
})
