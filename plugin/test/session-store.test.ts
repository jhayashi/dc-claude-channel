import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore } from '../dispatcher/session-store'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dc-session-store-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('SessionStore', () => {
  test('load returns null when no record exists', () => {
    const store = new SessionStore(dir)
    expect(store.load(42)).toBeNull()
  })

  test('save then load round-trips the session id', () => {
    const store = new SessionStore(dir)
    store.save(42, 'session-uuid-1')
    const rec = store.load(42)
    expect(rec).not.toBeNull()
    expect(rec!.sessionId).toBe('session-uuid-1')
    expect(typeof rec!.createdAt).toBe('number')
  })

  test('loadOrCreate creates a fresh uuid on first call, reuses on second', () => {
    const store = new SessionStore(dir)
    const first = store.loadOrCreate(42)
    expect(first.created).toBe(true)
    expect(first.record.sessionId.length).toBeGreaterThan(0)

    const second = store.loadOrCreate(42)
    expect(second.created).toBe(false)
    expect(second.record.sessionId).toBe(first.record.sessionId)
  })

  test('loadOrCreate gives different ids to different chats', () => {
    const store = new SessionStore(dir)
    const a = store.loadOrCreate(1).record.sessionId
    const b = store.loadOrCreate(2).record.sessionId
    expect(a).not.toBe(b)
  })

  test('delete removes the record', () => {
    const store = new SessionStore(dir)
    store.save(42, 'sess')
    store.delete(42)
    expect(store.load(42)).toBeNull()
    expect(existsSync(join(dir, '42.json'))).toBe(false)
  })

  test('delete is a no-op for missing chats', () => {
    const store = new SessionStore(dir)
    expect(() => store.delete(999)).not.toThrow()
  })

  test('survives a fresh store instance over the same dir', () => {
    const a = new SessionStore(dir)
    a.save(7, 'persisted-uuid')
    const b = new SessionStore(dir)
    expect(b.load(7)?.sessionId).toBe('persisted-uuid')
  })

  test('corrupt file is treated as missing', () => {
    const store = new SessionStore(dir)
    // Write garbage directly
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    writeFileSync(join(dir, '99.json'), '{not json')
    expect(store.load(99)).toBeNull()
  })
})
