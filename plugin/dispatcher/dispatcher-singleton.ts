import { connect } from 'node:net'
import { existsSync } from 'node:fs'

/**
 * Probe whether a dispatcher is already listening on the Unix socket.
 *
 * Used at server.ts startup to bail out fast when this process is a duplicate.
 * The project `.mcp.json` declares the `deltachat` server (`bun … start`) so
 * the host session can launch the dispatcher — but subagents spawn with cwd =
 * the plugin dir and auto-load the same `.mcp.json`, which would boot a rival
 * server.ts that blocks forever on the DC account-DB lock the live dispatcher
 * holds (every cold subagent spawn then hangs until the 1-hour turn timeout).
 *
 * Returns true if a live listener accepts a connection. A stale socket file
 * with no listener (connect → ECONNREFUSED / ENOENT) returns false, so the
 * real dispatcher can reclaim it.
 *
 * A connect TIMEOUT also returns true. Timeout means "something holds the
 * socket but didn't accept in time" — almost always a live dispatcher on a
 * loaded machine (e.g. a subagent running `bun test` saturating every core),
 * not a dead one. The failure modes are asymmetric: a duplicate that wrongly
 * exits costs one cold-spawn retry; a duplicate that wrongly proceeds unlinks
 * the LIVE dispatcher's socket out from under it (SocketServer unlinks before
 * bind), breaking every permission relay mid-turn and killing in-flight turns.
 * Genuinely-dead dispatchers are caught by the fast paths: no socket file →
 * false immediately, stale file → ECONNREFUSED → false.
 */
export function isDispatcherListening(
  socketPath: string,
  timeoutMs = 2000,
  connectFn: typeof connect = connect,
): Promise<boolean> {
  // No socket file → no dispatcher. Short-circuit so we never attempt a connect
  // that would raise ENOENT (the common host-startup case).
  if (!existsSync(socketPath)) return Promise.resolve(false)
  return new Promise((resolve) => {
    let settled = false
    let sock: ReturnType<typeof connect> | undefined
    const done = (v: boolean) => {
      if (settled) return
      settled = true
      try { sock?.destroy() } catch {}
      resolve(v)
    }
    const t = setTimeout(() => done(true), timeoutMs)
    t.unref?.()
    // connect() can throw synchronously (e.g. bun, missing socket path) or emit
    // 'error' async — both mean "no live dispatcher here".
    try {
      sock = connectFn(socketPath)
      sock.once('connect', () => done(true))
      sock.once('error', () => done(false))
    } catch {
      done(false)
    }
  })
}
