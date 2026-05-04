import { describe, test, expect, beforeEach, afterAll } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  getViewer,
  getSession,
  setViewer,
  setLastUpdate,
  clearLastUpdate,
  deleteViewer,
  loadPersistedViewers,
  setFileReviewersDir,
  _resetViewers,
} from '../file-reviewer'

const testDir = mkdtempSync(join(tmpdir(), 'dc-file-reviewer-test-'))

beforeEach(() => {
  _resetViewers()
  setFileReviewersDir(testDir)
  if (existsSync(testDir)) {
    for (const f of readdirSync(testDir)) {
      rmSync(join(testDir, f), { force: true })
    }
  }
})
afterAll(() => rmSync(testDir, { recursive: true, force: true }))

describe('file-reviewer persistence', () => {
  test('setViewer persists to disk', () => {
    setViewer(42, 1000)
    expect(readdirSync(testDir)).toContain('42.json')
  })

  test('loadPersistedViewers restores the in-memory map after reset', () => {
    setViewer(42, 1000)
    setLastUpdate(42, '{"payload":{"x":1}}')
    _resetViewers()
    expect(getViewer(42)).toBeNull()
    const restored = loadPersistedViewers()
    expect(restored).toEqual([{ chatId: 42, msgId: 1000 }])
    expect(getViewer(42)).toBe(1000)
    expect(getSession(42)?.lastUpdate).toBe('{"payload":{"x":1}}')
  })

  test('setLastUpdate persists but is a no-op without an existing session', () => {
    setLastUpdate(99, '{"payload":{"y":2}}')
    expect(existsSync(join(testDir, '99.json'))).toBe(false)
    setViewer(99, 2000)
    setLastUpdate(99, '{"payload":{"y":2}}')
    _resetViewers()
    loadPersistedViewers()
    expect(getSession(99)?.lastUpdate).toBe('{"payload":{"y":2}}')
  })

  test('clearLastUpdate removes the replay payload on disk', () => {
    setViewer(42, 1000)
    setLastUpdate(42, '{"payload":{"x":1}}')
    clearLastUpdate(42)
    _resetViewers()
    loadPersistedViewers()
    expect(getViewer(42)).toBe(1000)
    expect(getSession(42)?.lastUpdate).toBeUndefined()
  })

  test('deleteViewer removes from memory and disk', () => {
    setViewer(42, 1000)
    expect(existsSync(join(testDir, '42.json'))).toBe(true)
    deleteViewer(42)
    expect(getViewer(42)).toBeNull()
    expect(existsSync(join(testDir, '42.json'))).toBe(false)
  })

  test('loadPersistedViewers skips invalid json files', () => {
    setViewer(42, 1000)
    // Write a junk file alongside
    const fs = require('node:fs')
    fs.writeFileSync(join(testDir, 'junk.json'), 'not valid json')
    fs.writeFileSync(join(testDir, 'missing-fields.json'), '{"msgId": 5}')
    _resetViewers()
    const restored = loadPersistedViewers()
    expect(restored).toEqual([{ chatId: 42, msgId: 1000 }])
  })

  test('loadPersistedViewers handles missing dir', () => {
    rmSync(testDir, { recursive: true, force: true })
    expect(loadPersistedViewers()).toEqual([])
  })
})
