/**
 * Age-based deletion of dated event-log files under $DC_EVENT_DIR.
 *
 * The six streams (`tools-`, `turns-`, `permissions-`, `webxdc-`,
 * `agent-lifecycle-`, `subagent-stderr-`) already auto-roll daily by filename
 * (`<stream>-YYYY-MM-DD.log`, UTC). Without rotation those files
 * accumulate without bound — a Pi install runs out of disk; a desktop
 * install just wastes it. This module sweeps the dir and deletes files
 * whose filename date is older than `maxAgeDays`.
 *
 * We parse the filename date rather than reading mtime because mtime
 * drifts (backup tooling, `touch`, snapshot restores) which makes
 * retention unpredictable. The filename is the canonical "this file
 * belongs to day X" record.
 *
 * Non-matching files in `eventDir` (e.g. `dispatcher.log`, `.DS_Store`,
 * or a stray subdirectory) are left untouched. Per-file errors are
 * collected so a single chmod'd file doesn't abort the sweep.
 */

import { readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

/** Streams written by events.ts + events-lifecycle.ts. Order doesn't matter. */
const STREAM_NAMES = ['tools', 'turns', 'permissions', 'webxdc', 'agent-lifecycle', 'subagent-stderr'] as const

const FILENAME_RE = new RegExp(
  `^(${STREAM_NAMES.join('|')})-(\\d{4})-(\\d{2})-(\\d{2})\\.log$`,
)

const ONE_DAY_MS = 24 * 60 * 60 * 1000

export interface PruneResult {
  deleted: string[]
  errors: Array<{ file: string; err: unknown }>
}

/**
 * Delete log files in `eventDir` whose filename date is at least
 * `maxAgeDays` old relative to `now`. Returns the list of deleted file
 * basenames plus any per-file unlink errors that were swallowed.
 *
 * `maxAgeDays <= 0` (or non-finite) → no-op.
 * Missing `eventDir` → no-op (we don't create it; the writer does).
 */
export async function pruneEventLogs(
  eventDir: string,
  maxAgeDays: number,
  now: Date = new Date(),
): Promise<PruneResult> {
  const result: PruneResult = { deleted: [], errors: [] }
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) return result

  let names: string[]
  try {
    names = await readdir(eventDir)
  } catch {
    // No events dir yet — nothing to prune.
    return result
  }

  const nowMs = now.getTime()
  const thresholdMs = maxAgeDays * ONE_DAY_MS

  for (const name of names) {
    const m = FILENAME_RE.exec(name)
    if (!m) continue
    const [, , y, mo, d] = m
    // UTC midnight of the file's date. Compare against `now` in ms.
    const fileMs = Date.UTC(Number(y), Number(mo) - 1, Number(d))
    if (!Number.isFinite(fileMs)) continue
    if (nowMs - fileMs < thresholdMs) continue

    const fullPath = join(eventDir, name)
    // Defensive: ensure it's a regular file before unlinking. A weird
    // symlink or directory matching the pattern (vanishingly unlikely)
    // shouldn't get unlinked silently.
    try {
      const s = await stat(fullPath)
      if (!s.isFile()) continue
    } catch (err) {
      result.errors.push({ file: name, err })
      continue
    }

    try {
      await unlink(fullPath)
      result.deleted.push(name)
    } catch (err) {
      result.errors.push({ file: name, err })
    }
  }

  return result
}
