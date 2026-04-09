/**
 * Orphan subagent cleanup.
 *
 * On dispatcher startup, sweep for stale `claude -p ... --session-id`
 * processes left behind by a previous dispatcher run that crashed or
 * was killed without closing its cache. The new dispatcher's secret
 * already invalidates any survivors at the socket layer, but those
 * processes still hold a settings tempdir and burn memory until idle
 * timeout. Killing them on boot is belt-and-suspenders.
 *
 * Linux/macOS only. No-op (with a log line) on other platforms.
 */

import { spawnSync } from 'node:child_process'

export interface OrphanCleanupOptions {
  /** Our own pid; never killed. */
  selfPid: number
  /** Logger. */
  logf?: (fmt: string, ...args: unknown[]) => void
}

/**
 * Returns the number of orphans killed (or -1 if the platform isn't
 * supported / pgrep isn't available).
 */
export function cleanupOrphanSubagents(opts: OrphanCleanupOptions): number {
  const logf = opts.logf ?? (() => {})
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    logf('orphan-cleanup: skipping (platform=%s)', process.platform)
    return -1
  }

  // Match the literal stream-json arg pair we always pass — uniquely
  // identifies our subagents and won't catch the user's terminal
  // claude session.
  const marker = '--input-format stream-json --output-format stream-json'
  const result = spawnSync('pgrep', ['-af', '--', marker], { encoding: 'utf8' })
  if (result.status !== 0) {
    // pgrep returns 1 when no matches; that's the common-case "clean boot".
    if (result.status === 1) {
      logf('orphan-cleanup: no orphans found')
      return 0
    }
    logf('orphan-cleanup: pgrep failed status=%d err=%s', result.status, result.stderr)
    return -1
  }

  let killed = 0
  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const spaceIdx = trimmed.indexOf(' ')
    if (spaceIdx < 0) continue
    const pid = Number(trimmed.slice(0, spaceIdx))
    if (!Number.isFinite(pid) || pid === opts.selfPid) continue
    try {
      process.kill(pid, 'SIGTERM')
      logf('orphan-cleanup: SIGTERM pid=%d cmd=%s', pid, trimmed.slice(spaceIdx + 1))
      killed++
    } catch (err) {
      logf('orphan-cleanup: kill pid=%d failed: %v', pid, err)
    }
  }
  return killed
}
