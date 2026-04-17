import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScheduleStore, type ScheduledJob } from '../dispatcher/schedule-store.ts'

// Documents the contract: any teardown path (unpair OR resume-out) must
// remove per-chat schedule files so jobs don't live on after the binding
// is gone. The shared cleanupChatState in server.ts owns that — this test
// asserts the underlying store API still deletes atomically.

function fixture(o: Partial<ScheduledJob> = {}): ScheduledJob {
  return {
    jobId: 'x',
    chatId: 42,
    cron: '* * * * *',
    prompt: 'p',
    recurring: true,
    createdAt: new Date().toISOString(),
    expiresAt: null,
    lastFiredAt: null,
    targetMs: null,
    ...o,
  }
}

let dir: string
let store: ScheduleStore
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dc-resume-out-'))
  store = new ScheduleStore(dir)
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('resume-out cleanup contract', () => {
  test('deleteForChat removes every file for the chat', () => {
    store.save(fixture({ chatId: 42, jobId: 'j1' }))
    store.save(fixture({ chatId: 42, jobId: 'j2' }))
    store.save(fixture({ chatId: 99, jobId: 'j3' }))
    expect(store.deleteForChat(42)).toBe(2)
    expect(store.countForChat(42)).toBe(0)
    expect(store.countForChat(99)).toBe(1)
  })
})
