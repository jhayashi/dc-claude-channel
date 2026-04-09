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
  // claude session. We use `ps` (not pgrep) so we can see each
  // candidate's PPID and only kill processes that have been reparented
  // to init (PPID == 1), i.e. truly orphaned. A subagent owned by a
  // concurrent sibling dispatcher has PPID == that dispatcher's pid
  // and must be left alone — otherwise two dispatchers racing on
  // startup will SIGTERM each other's live subagents.
  const marker = '--input-format stream-json --output-format stream-json'
  const result = spawnSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8' })
  if (result.status !== 0) {
    logf('orphan-cleanup: ps failed status=%d err=%s', result.status, result.stderr)
    return -1
  }

  let killed = 0
  let skippedLive = 0
  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (!trimmed.includes(marker)) continue
    // Format: "<pid> <ppid> <args...>"
    const m = trimmed.match(/^(\d+)\s+(\d+)\s+(.*)$/)
    if (!m) continue
    const pid = Number(m[1])
    const ppid = Number(m[2])
    const cmd = m[3]
    if (!Number.isFinite(pid) || pid === opts.selfPid) continue
    if (ppid !== 1) {
      // Owned by a live parent (likely a sibling dispatcher). Skip.
      skippedLive++
      continue
    }
    try {
      process.kill(pid, 'SIGTERM')
      logf('orphan-cleanup: SIGTERM pid=%d (ppid=1) cmd=%s', pid, cmd)
      killed++
    } catch (err) {
      logf('orphan-cleanup: kill pid=%d failed: %v', pid, err)
    }
  }
  if (killed === 0 && skippedLive === 0) {
    logf('orphan-cleanup: no orphans found')
  } else if (skippedLive > 0) {
    logf('orphan-cleanup: skipped %d live subagent(s) owned by sibling dispatcher', skippedLive)
  }
  return killed
}
