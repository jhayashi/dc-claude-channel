import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  setCardSessionsDir, recordCardSession, updateCardSerial,
  loadCardSessions, pruneCardSessions, restoreCardSessions, handleUnknownCardUpdate,
} from '../dispatcher/card-sessions.js'

// #114 P3: card sessions survive dispatcher restarts. The store is the
// single source both the central registry and each card's module map
// restore from — lastSerial rides in the same record (safety invariant:
// a restored card must never replay old state-changing updates).

describe('card-sessions store (#114)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cardsess-')); setCardSessionsDir(dir) })
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })

  test('record → load round trip', () => {
    recordCardSession(101, 'teleport', 42)
    const all = loadCardSessions()
    expect(all['101'].appId).toBe('teleport')
    expect(all['101'].chatId).toBe(42)
    expect(all['101'].lastSerial).toBe(0)
    expect(all['101'].createdAt).toBeTruthy()
  })

  test('updateCardSerial persists the cursor; unknown msgId is a no-op', () => {
    recordCardSession(101, 'teleport', 42)
    updateCardSerial(101, 17)
    expect(loadCardSessions()['101'].lastSerial).toBe(17)
    updateCardSerial(999, 5) // must not throw or create a record
    expect(loadCardSessions()['999']).toBeUndefined()
  })

  test('missing file → {}; corrupt file → {}', () => {
    expect(loadCardSessions()).toEqual({})
    writeFileSync(join(dir, 'card-sessions.json'), '{not json')
    expect(loadCardSessions()).toEqual({})
  })

  test('prune keeps the most recent N by createdAt', () => {
    for (let i = 1; i <= 5; i++) recordCardSession(i, 'teleport', i)
    // force distinct createdAt ordering
    const all = loadCardSessions()
    const ids = Object.keys(all).map(Number).sort((a, b) => a - b)
    expect(ids.length).toBe(5)
    pruneCardSessions(2)
    const kept = Object.keys(loadCardSessions()).map(Number).sort((a, b) => a - b)
    expect(kept.length).toBe(2)
    expect(kept).toEqual([4, 5]) // insertion order ties resolved by later-wins
  })

  test('restoreCardSessions repopulates registry AND calls each app hook with lastSerial intact', () => {
    recordCardSession(101, 'teleport', 42)
    updateCardSerial(101, 17)
    recordCardSession(102, 'contacts', 43)
    recordCardSession(103, 'ghost-app', 44) // no matching app → skipped
    const restored: Array<[number, string, number, number]> = []
    const hooked: Array<[string, number, number]> = []
    const apps = [
      { id: 'teleport', restoreSession: (m: number, c: number) => hooked.push(['teleport', m, c]) },
      { id: 'contacts', restoreSession: (m: number, c: number) => hooked.push(['contacts', m, c]) },
    ]
    const n = restoreCardSessions({
      apps,
      register: (msgId, appId, chatId, lastSerial) => restored.push([msgId, appId, chatId, lastSerial]),
    })
    expect(n).toBe(2)
    expect(restored).toContainEqual([101, 'teleport', 42, 17]) // ← the safety invariant
    expect(restored).toContainEqual([102, 'contacts', 43, 0])
    expect(hooked).toContainEqual(['teleport', 101, 42])
    expect(hooked).toContainEqual(['contacts', 102, 43])
  })

  test('handleUnknownCardUpdate notifies once per msgId and dedupes', async () => {
    const sent: Array<[number, string]> = []
    const notified = new Set<number>()
    const deps = {
      resolveChatId: async () => 7,
      send: async (chatId: number, text: string) => { sent.push([chatId, text]) },
      notified,
    }
    expect(await handleUnknownCardUpdate(55, deps)).toBe(true)
    expect(await handleUnknownCardUpdate(55, deps)).toBe(false) // deduped
    expect(sent.length).toBe(1)
    expect(sent[0][0]).toBe(7)
    expect(sent[0][1].toLowerCase()).toContain('expired')
    expect(sent[0][1].toLowerCase()).toContain('fresh')
  })

  test('handleUnknownCardUpdate degrades silently when the chat is unresolvable', async () => {
    const deps = { resolveChatId: async () => null, send: async () => { throw new Error('must not send') }, notified: new Set<number>() }
    expect(await handleUnknownCardUpdate(56, deps)).toBe(false)
  })
})
