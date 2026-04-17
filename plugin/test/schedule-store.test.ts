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

describe('ScheduleStore robustness', () => {
  test('corrupt JSON file is skipped, other jobs still load', () => {
    store.save(fixture({ chatId: 22, jobId: 'good11' }))
    writeFileSync(join(dir, '22-bad222.json'), '{not valid json')
    const loaded = store.loadAll()
    expect(loaded.length).toBe(1)
    expect(loaded[0].jobId).toBe('good11')
  })

  test('non-.json files in the dir are ignored', () => {
    store.save(fixture({ chatId: 22, jobId: 'good11' }))
    writeFileSync(join(dir, 'notes.txt'), 'hello')
    writeFileSync(join(dir, '22-tmp.json.tmp'), '{}')
    const loaded = store.loadAll()
    expect(loaded.length).toBe(1)
  })

  test('save leaves no .tmp file behind on success', () => {
    store.save(fixture({ chatId: 22, jobId: 'abc123' }))
    const leftovers = readdirSync(dir).filter(n => n.endsWith('.tmp'))
    expect(leftovers).toEqual([])
  })

  test('save overwrites existing job atomically', () => {
    store.save(fixture({ chatId: 22, jobId: 'abc123', prompt: 'v1' }))
    store.save(fixture({ chatId: 22, jobId: 'abc123', prompt: 'v2' }))
    const loaded = store.loadForChat(22)
    expect(loaded.length).toBe(1)
    expect(loaded[0].prompt).toBe('v2')
  })
})

describe('ScheduleStore.moveForChat', () => {
  test('moves all jobs from one chat to another', () => {
    store.save(fixture({ chatId: 22, jobId: 'aaa111' }))
    store.save(fixture({ chatId: 22, jobId: 'bbb222' }))
    store.save(fixture({ chatId: 87, jobId: 'ccc333' }))

    const moved = store.moveForChat(22, 99)
    expect(moved).toBe(2)
    expect(store.countForChat(22)).toBe(0)
    expect(store.countForChat(87)).toBe(1)
    expect(store.countForChat(99)).toBe(2)
    for (const j of store.loadForChat(99)) expect(j.chatId).toBe(99)
  })

  test('no-op when source chat has no jobs', () => {
    expect(store.moveForChat(22, 99)).toBe(0)
  })

  test('no-op when source == destination', () => {
    store.save(fixture({ chatId: 22, jobId: 'aaa111' }))
    expect(store.moveForChat(22, 22)).toBe(0)
    expect(store.countForChat(22)).toBe(1)
  })

  test('throws on job-id collision at destination', () => {
    store.save(fixture({ chatId: 22, jobId: 'shared' }))
    store.save(fixture({ chatId: 99, jobId: 'shared' }))
    expect(() => store.moveForChat(22, 99)).toThrow(/collision/i)
    // Source should be untouched — no partial move
    expect(store.countForChat(22)).toBe(1)
    expect(store.countForChat(99)).toBe(1)
  })
})
