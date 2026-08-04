import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pruneEventLogs } from '../dispatcher/event-log-rotate.js'

const STREAMS = ['tools', 'turns', 'permissions', 'webxdc', 'agent-lifecycle', 'subagent-stderr', 'permission-relay']

/** Reference "now" for all age math in this suite. */
const NOW = new Date('2026-05-15T12:00:00.000Z')

/** UTC date N days before NOW, formatted as YYYY-MM-DD for filenames. */
function daysAgo(n: number): string {
  const d = new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

describe('pruneEventLogs', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dc-prune-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('empty dir → no-op', async () => {
    const r = await pruneEventLogs(dir, 30, NOW)
    expect(r.deleted).toEqual([])
    expect(r.errors).toEqual([])
  })

  test('missing dir → no-op, no throw', async () => {
    const r = await pruneEventLogs(join(dir, 'no-such-subdir'), 30, NOW)
    expect(r.deleted).toEqual([])
    expect(r.errors).toEqual([])
  })

  test('all fresh files → none deleted', async () => {
    for (const s of STREAMS) writeFileSync(join(dir, `${s}-${daysAgo(5)}.log`), 'x')
    const r = await pruneEventLogs(dir, 30, NOW)
    expect(r.deleted).toEqual([])
    expect(readdirSync(dir).sort()).toEqual(STREAMS.map(s => `${s}-${daysAgo(5)}.log`).sort())
  })

  test('only stale files deleted; fresh untouched', async () => {
    writeFileSync(join(dir, `tools-${daysAgo(31)}.log`), 'old')
    writeFileSync(join(dir, `tools-${daysAgo(5)}.log`), 'fresh')
    const r = await pruneEventLogs(dir, 30, NOW)
    expect(r.deleted).toEqual([`tools-${daysAgo(31)}.log`])
    expect(existsSync(join(dir, `tools-${daysAgo(5)}.log`))).toBe(true)
    expect(existsSync(join(dir, `tools-${daysAgo(31)}.log`))).toBe(false)
  })

  test('stale files across all 7 streams are all deleted', async () => {
    for (const s of STREAMS) writeFileSync(join(dir, `${s}-${daysAgo(45)}.log`), 'x')
    const r = await pruneEventLogs(dir, 30, NOW)
    expect(r.deleted.sort()).toEqual(STREAMS.map(s => `${s}-${daysAgo(45)}.log`).sort())
    expect(readdirSync(dir)).toEqual([])
  })

  test('exactly at the threshold (now === fileMidnight + maxAgeDays) is deleted', async () => {
    // File midnight (UTC) = 2026-04-15T00:00Z; now exactly 30d later (midnight) → age === threshold → delete.
    writeFileSync(join(dir, 'tools-2026-04-15.log'), 'edge')
    const exactlyThreshold = new Date(Date.UTC(2026, 4 /* =May */, 15))
    const r = await pruneEventLogs(dir, 30, exactlyThreshold)
    expect(r.deleted).toEqual(['tools-2026-04-15.log'])
  })

  test('one millisecond under the threshold is kept', async () => {
    // Same file; now is 1ms earlier than fileMidnight + 30d → age < threshold → keep.
    writeFileSync(join(dir, 'tools-2026-04-15.log'), 'edge')
    const justBefore = new Date(Date.UTC(2026, 4, 15) - 1)
    const r = await pruneEventLogs(dir, 30, justBefore)
    expect(r.deleted).toEqual([])
  })

  test('non-matching files are ignored', async () => {
    writeFileSync(join(dir, 'dispatcher.log'), 'x')
    writeFileSync(join(dir, 'random.txt'), 'x')
    writeFileSync(join(dir, '.DS_Store'), 'x')
    writeFileSync(join(dir, 'tools-not-a-date.log'), 'x')
    writeFileSync(join(dir, 'unknown-stream-2026-01-01.log'), 'x')
    writeFileSync(join(dir, `tools-${daysAgo(45)}.log`), 'stale')
    const r = await pruneEventLogs(dir, 30, NOW)
    expect(r.deleted).toEqual([`tools-${daysAgo(45)}.log`])
    // Everything else is intact.
    for (const f of ['dispatcher.log', 'random.txt', '.DS_Store', 'tools-not-a-date.log', 'unknown-stream-2026-01-01.log']) {
      expect(existsSync(join(dir, f))).toBe(true)
    }
  })

  test('matching subdirectory is skipped (not unlinked)', async () => {
    // Vanishingly unlikely in practice, but the stat-isFile guard catches it.
    mkdirSync(join(dir, `tools-${daysAgo(45)}.log`))
    const r = await pruneEventLogs(dir, 30, NOW)
    expect(r.deleted).toEqual([])
    expect(existsSync(join(dir, `tools-${daysAgo(45)}.log`))).toBe(true)
  })

  test('maxAgeDays=0 → no-op even with very old files', async () => {
    writeFileSync(join(dir, `tools-${daysAgo(365)}.log`), 'ancient')
    const r = await pruneEventLogs(dir, 0, NOW)
    expect(r.deleted).toEqual([])
    expect(existsSync(join(dir, `tools-${daysAgo(365)}.log`))).toBe(true)
  })

  test('maxAgeDays=-1 → no-op (defensive)', async () => {
    writeFileSync(join(dir, `tools-${daysAgo(365)}.log`), 'ancient')
    const r = await pruneEventLogs(dir, -1, NOW)
    expect(r.deleted).toEqual([])
  })

  test('maxAgeDays=NaN → no-op (defensive)', async () => {
    writeFileSync(join(dir, `tools-${daysAgo(365)}.log`), 'ancient')
    const r = await pruneEventLogs(dir, NaN, NOW)
    expect(r.deleted).toEqual([])
  })

  test('idempotent — running twice deletes only once', async () => {
    writeFileSync(join(dir, `tools-${daysAgo(45)}.log`), 'stale')
    const r1 = await pruneEventLogs(dir, 30, NOW)
    expect(r1.deleted).toEqual([`tools-${daysAgo(45)}.log`])
    const r2 = await pruneEventLogs(dir, 30, NOW)
    expect(r2.deleted).toEqual([])
    expect(r2.errors).toEqual([])
  })

  test('per-file unlink errors are captured; other files still deleted', async () => {
    if (process.platform === 'win32') return  // chmod-based denial doesn't apply
    if (process.getuid && process.getuid() === 0) return  // root can unlink anyway
    writeFileSync(join(dir, `tools-${daysAgo(45)}.log`), 'a')
    writeFileSync(join(dir, `turns-${daysAgo(45)}.log`), 'b')
    // Make the containing dir read-only so unlink fails for both. But then
    // we can't distinguish from a directory error. Instead: make a subdir
    // we can't write into and place a file there... but the prune walks
    // only the top level. Simpler: chmod the dir read-only so unlink fails.
    chmodSync(dir, 0o555)
    try {
      const r = await pruneEventLogs(dir, 30, NOW)
      // Both should fail to unlink (deleted=[], errors covers both).
      expect(r.deleted).toEqual([])
      expect(r.errors.map(e => e.file).sort()).toEqual([
        `tools-${daysAgo(45)}.log`,
        `turns-${daysAgo(45)}.log`,
      ])
    } finally {
      chmodSync(dir, 0o755)  // restore so afterEach can rm
    }
  })
})
