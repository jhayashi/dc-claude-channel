import { describe, test, expect, beforeEach } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { logLifecycleEvent, setLifecycleEventDir } from '../events-lifecycle.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lifecycle-')); setLifecycleEventDir(dir) })

describe('lifecycle event log', () => {
  test('appends a graduation entry as JSONL', () => {
    logLifecycleEvent({ kind: 'graduation', chatId: 42, agentId: 'a-1', sessionId: 's-1', leafIds: ['sleep-coach'], fromCoach: true })
    const files = readdirSync(dir)
    expect(files.length).toBe(1)
    const line = readFileSync(join(dir, files[0]), 'utf-8').trim()
    const parsed = JSON.parse(line)
    expect(parsed.kind).toBe('graduation')
    expect(parsed.chatId).toBe(42)
    expect(parsed.agentId).toBe('a-1')
    expect(parsed.fromCoach).toBe(true)
    expect(typeof parsed.ts).toBe('string')
  })

  test('multiple events on same UTC date land in same file', () => {
    logLifecycleEvent({ kind: 'graduation', chatId: 1, agentId: 'a', sessionId: 's', leafIds: [], fromCoach: true })
    logLifecycleEvent({ kind: 'refine-complete', chatId: 1, agentId: 'a', sessionId: 's' })
    const files = readdirSync(dir)
    expect(files.length).toBe(1)
    const lines = readFileSync(join(dir, files[0]), 'utf-8').trim().split('\n')
    expect(lines.length).toBe(2)
  })
})
