import { describe, test, expect } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { checkReady } from '../bootstrap'

describe('bootstrap.checkReady', () => {
  test('returns true when bun.lock is newer than package.json', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'bootstrap-'))
    try {
      writeFileSync(join(tmp, 'package.json'), '{}')
      writeFileSync(join(tmp, 'bun.lock'), '')
      const newer = new Date(Date.now() + 1000)
      utimesSync(join(tmp, 'bun.lock'), newer, newer)
      expect(checkReady(tmp)).toBe(true)
    } finally { rmSync(tmp, { recursive: true, force: true }) }
  })

  test('returns false when bun.lock is missing', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'bootstrap-'))
    try {
      writeFileSync(join(tmp, 'package.json'), '{}')
      expect(checkReady(tmp)).toBe(false)
    } finally { rmSync(tmp, { recursive: true, force: true }) }
  })

  test('returns false when package.json is newer than bun.lock', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'bootstrap-'))
    try {
      writeFileSync(join(tmp, 'bun.lock'), '')
      const later = new Date(Date.now() + 1000)
      writeFileSync(join(tmp, 'package.json'), '{}')
      utimesSync(join(tmp, 'package.json'), later, later)
      expect(checkReady(tmp)).toBe(false)
    } finally { rmSync(tmp, { recursive: true, force: true }) }
  })
})

describe('bootstrap.waitForReady', () => {
  test('resolves when _signalComplete is called', async () => {
    const { waitForReady, _signalComplete, _resetForTest } = await import('../bootstrap')
    _resetForTest()
    const p = waitForReady()
    _signalComplete()
    await expect(p).resolves.toBeUndefined()
  })

  test('rejects after the configured timeout', async () => {
    const { waitForReady, _resetForTest } = await import('../bootstrap')
    _resetForTest()
    await expect(waitForReady(50)).rejects.toThrow(/install did not complete/)
  }, 1000)

  test('rejects when _signalFailure is called', async () => {
    const { waitForReady, _signalFailure, _resetForTest } = await import('../bootstrap')
    _resetForTest()
    const p = waitForReady()
    _signalFailure(new Error('boom'))
    await expect(p).rejects.toThrow(/boom/)
  })
})
