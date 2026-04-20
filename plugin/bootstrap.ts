/**
 * Bootstrap: readiness gate + background `bun install`.
 *
 * server.ts calls checkReady() on startup. If deps are present, it
 * calls _signalComplete() and the gate opens immediately. Otherwise
 * it kicks off runInstallInBackground() and every DC tool handler
 * + voice-message handler awaits waitForReady() before running so
 * that the user sees pairing UX before the native install finishes.
 */

import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

/**
 * True iff deps are installed and not stale. Matches the logic used
 * by scripts/session-start.sh: `bun.lock` exists and is newer than
 * `package.json`. bun writes the lock atomically at end of install,
 * so this is robust against partial installs.
 */
export function checkReady(pluginDir: string): boolean {
  const lock = join(pluginDir, 'bun.lock')
  const pkg = join(pluginDir, 'package.json')
  if (!existsSync(lock) || !existsSync(pkg)) return false
  try {
    return statSync(lock).mtimeMs > statSync(pkg).mtimeMs
  } catch { return false }
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

let readyPromise: Promise<void> | null = null
let readyResolve: (() => void) | null = null
let readyReject: ((e: Error) => void) | null = null
let timeoutHandle: ReturnType<typeof setTimeout> | null = null

/** Await this before any DC tool handler or voice-message handler runs. */
export function waitForReady(timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<void> {
  if (!readyPromise) {
    readyPromise = new Promise<void>((resolve, reject) => {
      readyResolve = resolve
      readyReject = reject
      timeoutHandle = setTimeout(() => {
        reject(new Error(`install did not complete within ${timeoutMs}ms`))
      }, timeoutMs)
    })
  }
  return readyPromise
}

export function _signalComplete(): void {
  if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null }
  // Ensure the gate exists so callers that await after signalling still resolve.
  if (!readyPromise) {
    readyPromise = Promise.resolve()
    return
  }
  readyResolve?.()
}

export function _signalFailure(err: Error): void {
  if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null }
  if (!readyPromise) {
    readyPromise = Promise.reject(err)
    // Swallow unhandled-rejection noise — callers await when they're ready.
    readyPromise.catch(() => {})
    return
  }
  readyReject?.(err)
}

/** Test-only reset. */
export function _resetForTest(): void {
  if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null }
  readyPromise = null
  readyResolve = null
  readyReject = null
}

/**
 * Fork `bun install` in the plugin dir. Resolves the ready gate on
 * success, rejects it on failure. Returns the same promise the gate
 * is tied to so the caller can log the outcome.
 */
export async function runInstallInBackground(
  pluginDir: string,
  logf: (fmt: string, ...a: unknown[]) => void,
): Promise<void> {
  // Prime the gate promise before we fork, so any early waitForReady()
  // caller sees the same promise we resolve/reject below.
  waitForReady()
  logf('bootstrap: running `bun install` in %s', pluginDir)
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('bun', ['install'], { cwd: pluginDir, stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout.on('data', d => logf('bun install: %s', d.toString().trimEnd()))
      child.stderr.on('data', d => logf('bun install: %s', d.toString().trimEnd()))
      child.on('exit', code => code === 0 ? resolve() : reject(new Error(`bun install exited ${code}`)))
      child.on('error', reject)
    })
    _signalComplete()
    logf('bootstrap: install complete')
  } catch (err) {
    logf('bootstrap: install FAILED: %v', err)
    _signalFailure(err as Error)
    throw err
  }
}
