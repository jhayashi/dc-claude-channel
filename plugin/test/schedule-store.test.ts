import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScheduleStore, type ScheduledJob } from '../dispatcher/schedule-store.ts'

function fixture(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    jobId: 'a1b2c3',
    chatId: 22,
    cron: '0 9 * * 1-5',
    prompt: 'summarize yesterdays commits',
    recurring: true,
    createdAt: '2026-04-11T10:00:00.000Z',
    expiresAt: null,
    lastFiredAt: null,
    targetMs: null,
    ...overrides,
  }
}

let dir: string
let store: ScheduleStore
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dc-schedule-store-'))
  store = new ScheduleStore(dir)
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('ScheduleStore.save + loadForChat', () => {
  test('round-trips a single job', () => {
    const job = fixture()
    store.save(job)
    const loaded = store.loadForChat(22)
    expect(loaded.length).toBe(1)
    expect(loaded[0]).toEqual(job)
  })

  test('loadForChat ignores other chats', () => {
    store.save(fixture({ chatId: 22, jobId: 'aaa111' }))
    store.save(fixture({ chatId: 87, jobId: 'bbb222' }))
    expect(store.loadForChat(22).length).toBe(1)
    expect(store.loadForChat(22)[0].jobId).toBe('aaa111')
  })

  test('countForChat', () => {
    store.save(fixture({ chatId: 22, jobId: 'aaa111' }))
    store.save(fixture({ chatId: 22, jobId: 'bbb222' }))
    store.save(fixture({ chatId: 87, jobId: 'ccc333' }))
    expect(store.countForChat(22)).toBe(2)
    expect(store.countForChat(87)).toBe(1)
    expect(store.countForChat(99)).toBe(0)
  })
})

describe('ScheduleStore.loadAll', () => {
  test('returns jobs from all chats', () => {
    store.save(fixture({ chatId: 22, jobId: 'aaa111' }))
    store.save(fixture({ chatId: 87, jobId: 'bbb222' }))
    const all = store.loadAll()
    expect(all.length).toBe(2)
    const ids = all.map(j => j.jobId).sort()
    expect(ids).toEqual(['aaa111', 'bbb222'])
  })

  test('returns empty array when dir does not exist yet', () => {
    const freshDir = mkdtempSync(join(tmpdir(), 'dc-schedule-fresh-'))
    rmSync(freshDir, { recursive: true, force: true })
    const freshStore = new ScheduleStore(freshDir)
    expect(freshStore.loadAll()).toEqual([])
  })
})

describe('ScheduleStore.delete', () => {
  test('delete removes one job file', () => {
    store.save(fixture({ chatId: 22, jobId: 'aaa111' }))
    store.save(fixture({ chatId: 22, jobId: 'bbb222' }))
    expect(store.delete(22, 'aaa111')).toBe(true)
    expect(store.countForChat(22)).toBe(1)
    expect(store.loadForChat(22)[0].jobId).toBe('bbb222')
  })

  test('delete returns false when job does not exist', () => {
    expect(store.delete(22, 'nope99')).toBe(false)
  })

  test('deleteForChat wipes all jobs for one chat', () => {
    store.save(fixture({ chatId: 22, jobId: 'aaa111' }))
    store.save(fixture({ chatId: 22, jobId: 'bbb222' }))
    store.save(fixture({ chatId: 87, jobId: 'ccc333' }))
    expect(store.deleteForChat(22)).toBe(2)
    expect(store.countForChat(22)).toBe(0)
    expect(store.countForChat(87)).toBe(1)
  })
})
