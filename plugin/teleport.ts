/**
 * Session teleport — bridge a DC chat's session UUID with a local
 * terminal `claude` session. Pure helpers; no DC client I/O.
 *
 *   DC → terminal: buildResumeCommand(chatId) emits `cd … && claude --resume <uuid>`.
 *   Terminal → DC: listResumeCandidates() + attachSessionToChat(chatId, sessionId).
 *
 * Roots are overridable for tests:
 *   - projectsRoot (default ~/.claude/projects) — where claude stores <cwd-hash>/<uuid>.jsonl.
 *   - bindings injected via plugin/bindings.ts (setBindingsDir).
 */

import { existsSync, readdirSync, statSync, openSync, readSync, closeSync, mkdirSync } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as bindings from './bindings.js'

/**
 * Absolute path to the plugin directory. Derived from this module's own URL,
 * not `process.cwd()`, because the dispatcher may be launched from anywhere.
 * Subagents spawn with CWD = PLUGIN_DIR, so their session files live under
 * projectHashForCwd(PLUGIN_DIR).
 */
export const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))

let PROJECTS_ROOT = join(homedir(), '.claude', 'projects')

/** Override the claude projects root (for tests). */
export function setProjectsRoot(dir: string): void {
  PROJECTS_ROOT = dir
}

/**
 * Convert an absolute CWD to claude's project-hash directory name.
 * Claude replaces every `/` with `-`. `/a/b/c` → `-a-b-c`. Lossy inverse
 * when paths contain `-`, which is acceptable for display.
 */
export function projectHashForCwd(cwd: string): string {
  if (!cwd.startsWith('/')) {
    throw new Error(`projectHashForCwd: expected absolute path, got ${cwd}`)
  }
  return cwd.replace(/\//g, '-')
}

export interface TeleportCommand {
  command: string
  sessionId: string
  sessionPath: string
}

export interface TeleportError {
  error: string
}

/**
 * Build a `cd <cwd> && claude --resume <uuid>` command for a chat's
 * bound session. Returns TeleportError if no binding, no sessionId,
 * or the session file is missing.
 *
 * cwd defaults to PLUGIN_DIR — where subagents are spawned, and where
 * their session files live. Do NOT use process.cwd(); the dispatcher
 * may be launched from anywhere.
 */
export function buildResumeCommand(
  chatId: number,
  cwd: string = PLUGIN_DIR,
): TeleportCommand | TeleportError {
  const binding = bindings.getBinding(chatId)
  if (!binding?.sessionId) {
    return { error: 'No session yet. Send a message in this chat to initialize, then try again.' }
  }
  const sessionId = binding.sessionId
  const sessionPath = join(PROJECTS_ROOT, projectHashForCwd(cwd), `${sessionId}.jsonl`)
  if (!existsSync(sessionPath)) {
    return { error: `Session file not found at ${sessionPath}. The session may have been deleted; clear the binding and start a new chat.` }
  }
  return {
    command: `cd ${cwd} && claude --resume ${sessionId}`,
    sessionId,
    sessionPath,
  }
}

export interface Candidate {
  sessionId: string
  sessionPath: string
  cwd: string
  mtimeMs: number
  summary: string | null
  /** Size-based estimate (not exact line count) to avoid scanning large files. */
  messageCount: number | null
  /** True when mtime is within ~5 minutes — a terminal may still be using it. */
  isProbablyLive: boolean
}

export interface ListOptions {
  /** Maximum number of candidates to return (default 25). */
  limit?: number
  /** Skip sessions with mtime older than this (default 2, per Joe). */
  maxAgeDays?: number
}

const LIVE_WINDOW_MS = 5 * 60 * 1000

/**
 * Scan ~/.claude/projects/STAR/STAR.jsonl and return recent sessions not
 * already bound to a DC chat. Used by the agent-setup card to populate
 * the "Import terminal session" picker.
 */
export function listResumeCandidates(opts: ListOptions = {}): Candidate[] {
  const limit = opts.limit ?? 25
  const maxAgeDays = opts.maxAgeDays ?? 2
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
  const now = Date.now()

  if (!existsSync(PROJECTS_ROOT)) return []

  const boundSessionIds = new Set(
    bindings.listBindings().map(b => b.sessionId).filter((x): x is string => !!x),
  )

  const candidates: Candidate[] = []
  for (const projectDir of readdirSync(PROJECTS_ROOT)) {
    const projectPath = join(PROJECTS_ROOT, projectDir)
    let dstat: ReturnType<typeof statSync>
    try { dstat = statSync(projectPath) } catch { continue }
    if (!dstat.isDirectory()) continue

    const cwd = cwdFromProjectHash(projectDir)
    let entries: string[]
    try { entries = readdirSync(projectPath) } catch { continue }

    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue
      const sessionId = entry.slice(0, -'.jsonl'.length)
      if (boundSessionIds.has(sessionId)) continue

      const sessionPath = join(projectPath, entry)
      let fstat: ReturnType<typeof statSync>
      try { fstat = statSync(sessionPath) } catch { continue }
      if (fstat.mtimeMs < cutoff) continue

      const { summary, messageCount } = readSessionMeta(sessionPath, fstat.size)
      candidates.push({
        sessionId,
        sessionPath,
        cwd,
        mtimeMs: fstat.mtimeMs,
        summary,
        messageCount,
        isProbablyLive: now - fstat.mtimeMs < LIVE_WINDOW_MS,
      })
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return candidates.slice(0, limit)
}

/** Inverse of projectHashForCwd. Lossy when paths contain `-`; display only. */
function cwdFromProjectHash(hash: string): string {
  return hash.replace(/-/g, '/')
}

/**
 * Read the first ~4 KB of a session file and parse line 1 for the summary.
 * Estimates message count from file size (~400 bytes/line) instead of
 * counting newlines — avoids scanning multi-MB session files.
 */
function readSessionMeta(path: string, sizeBytes: number): { summary: string | null; messageCount: number | null } {
  let summary: string | null = null
  try {
    const fd = openSync(path, 'r')
    const buf = Buffer.alloc(4096)
    const n = readSync(fd, buf, 0, 4096, 0)
    closeSync(fd)
    const head = buf.slice(0, n).toString('utf-8')
    const nl = head.indexOf('\n')
    if (nl > 0) {
      try {
        const obj = JSON.parse(head.slice(0, nl)) as { summary?: string }
        if (typeof obj.summary === 'string') summary = obj.summary
      } catch { /* first line isn't JSON; leave summary null */ }
    }
  } catch { /* ignore */ }
  const messageCount = sizeBytes > 0 ? Math.max(1, Math.round(sizeBytes / 400)) : null
  return { summary, messageCount }
}

/**
 * Attach an existing claude session UUID to a DC chat. Finds the source
 * `.jsonl` file under PROJECTS_ROOT, copies it into the plugin hash dir
 * (or skips if it's already there), and writes a binding. Preserves
 * existing binding fields (agentId, inheritClaudeMd, createdAt).
 *
 * Throws if the session isn't found on disk or is already bound to
 * another DC chat.
 */
export async function attachSessionToChat(
  chatId: number,
  sessionId: string,
  destCwd: string = PLUGIN_DIR,
): Promise<void> {
  for (const b of bindings.listBindings()) {
    if (b.sessionId === sessionId && b.chatId !== chatId) {
      throw new Error(`Session ${sessionId} is already bound to chat ${b.chatId}. Detach it there first.`)
    }
  }

  const srcPath = findSessionFile(sessionId)
  if (!srcPath) {
    throw new Error(`Session ${sessionId} not found under ${PROJECTS_ROOT}.`)
  }

  const destDir = join(PROJECTS_ROOT, projectHashForCwd(destCwd))
  const destPath = join(destDir, `${sessionId}.jsonl`)

  if (srcPath !== destPath) {
    mkdirSync(destDir, { recursive: true })
    await copyFile(srcPath, destPath)
  }

  const existing = bindings.getBinding(chatId)
  bindings.saveBinding({
    chatId,
    agentId: existing?.agentId,
    inheritClaudeMd: existing?.inheritClaudeMd,
    sessionId,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  })
}

function findSessionFile(sessionId: string): string | null {
  if (!existsSync(PROJECTS_ROOT)) return null
  for (const dir of readdirSync(PROJECTS_ROOT)) {
    const p = join(PROJECTS_ROOT, dir, `${sessionId}.jsonl`)
    if (existsSync(p)) return p
  }
  return null
}
