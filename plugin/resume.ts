/**
 * Session resume — bridge a DC chat's session UUID with a local
 * terminal `claude` session. Pure helpers; no DC client I/O.
 *
 *   DC → terminal: buildResumeCommand(chatId) emits `cd … && claude --resume <uuid>`.
 *   Terminal → DC: listResumeCandidates() + attachSessionToChat(chatId, sessionId).
 *
 * Formerly called "teleport" — the user-facing tool description still
 * mentions that word so the model routes "teleport" utterances here.
 *
 * Roots are overridable for tests:
 *   - projectsRoot (default ~/.claude/projects) — where claude stores <cwd-hash>/<uuid>.jsonl.
 *   - bindings injected via plugin/bindings.ts (setBindingsDir).
 */

import { existsSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as bindings from './bindings.js'

/**
 * Absolute path to the plugin directory. Derived from this module's own URL,
 * not `process.cwd()`, because the dispatcher may be launched from anywhere.
 * Kept exported for tests and as a last-resort fallback; live subagent cwd
 * now comes from the per-chat binding.workingDir.
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

export interface ResumeCommand {
  command: string
  sessionId: string
  sessionPath: string
  sessionName: string | null
}

export interface ResumeError {
  error: string
}

/**
 * Build a `cd <cwd> && claude --resume <uuid>` command for a chat's
 * bound session. Returns ResumeError if no binding, no sessionId,
 * or the session file is missing.
 *
 * cwd comes from the binding's workingDir — the same dir the subagent
 * was spawned in, so claude's `--resume` finds the .jsonl on the first
 * try. Terminal and DC now share the exact same file on disk; no copy,
 * no sync. Falls back to PLUGIN_DIR only for legacy bindings from before
 * workingDir was tracked — those sessions were written under PLUGIN_DIR's
 * project hash by the old spawn path.
 */
export function buildResumeCommand(
  chatId: number,
  opts: { cwd?: string; chatName?: string } = {},
): ResumeCommand | ResumeError {
  const binding = bindings.getBinding(chatId)
  if (!binding?.sessionId) {
    return { error: 'No session yet. Send a message in this chat to initialize, then try again.' }
  }
  const sessionId = binding.sessionId

  const cwd = opts.cwd ?? binding.workingDir ?? PLUGIN_DIR
  const sessionPath = join(PROJECTS_ROOT, projectHashForCwd(cwd), `${sessionId}.jsonl`)

  if (!existsSync(sessionPath)) {
    return { error: `Session file not found for ${sessionId}. The session may have been deleted; clear the binding and start a new chat.` }
  }

  const nameFlag = opts.chatName ? ` --name ${shellQuote(opts.chatName)}` : ''
  return {
    command: `cd ${cwd} && claude --resume ${sessionId}${nameFlag}`,
    sessionId,
    sessionPath,
    sessionName: opts.chatName ?? null,
  }
}

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

export interface Candidate {
  sessionId: string
  sessionPath: string
  cwd: string
  mtimeMs: number
  summary: string | null
  /** Session display name from `--name` flag (stored as custom-title/agent-name in .jsonl). */
  sessionName: string | null
  /** Size-based estimate (not exact line count) to avoid scanning large files. */
  messageCount: number | null
}

export interface ListOptions {
  /** Maximum number of candidates to return (default 25). */
  limit?: number
  /** Skip sessions with mtime older than this (default 5, per Joe). */
  maxAgeDays?: number
}

/**
 * Check whether any process has a file open using fuser(1).
 * Returns true if at least one process holds the file.
 */
function isFileInUse(path: string): boolean {
  try {
    const result = spawnSync('fuser', [path], { timeout: 3000, stdio: 'pipe' })
    return result.status === 0
  } catch {
    return false
  }
}

/**
 * Return true when a session's `.jsonl` is currently held open by any
 * process (via fuser). Used at attach time to guard against a session
 * going live between listResumeCandidates() and the attach click.
 * Returns false if the session file can't be found.
 */
export function isSessionLive(sessionId: string): boolean {
  const path = findSessionFile(sessionId)
  if (!path) return false
  return isFileInUse(path)
}

/**
 * Scan ~/.claude/projects/STAR/STAR.jsonl and return recent claude
 * sessions eligible for resume. Excludes:
 *   - sessions already bound to a DC chat
 *   - sessions whose `.jsonl` is currently held open by any process
 *     (single-writer guard — includes the terminal Claude running this
 *     very dispatcher, which would deadlock if you attached its own
 *     session into a DC chat).
 * Orphan DC-born sessions (cwd no longer bound) are included so they
 * can be rescued into a new chat. With the per-chat cwd model each
 * session has exactly one on-disk copy, so no dedup is needed —
 * duplicate-copy entries left over from the old copy-based model will
 * age out of the 5-day window naturally.
 */
export function listResumeCandidates(opts: ListOptions = {}): Candidate[] {
  const limit = opts.limit ?? 25
  const maxAgeDays = opts.maxAgeDays ?? 5
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000

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

      if (isFileInUse(sessionPath)) continue

      const { summary, sessionName, messageCount } = readSessionMeta(sessionPath, fstat.size)
      candidates.push({
        sessionId,
        sessionPath,
        cwd,
        mtimeMs: fstat.mtimeMs,
        summary,
        sessionName,
        messageCount,
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
 * Read metadata from a session file: summary from the head (line 1-ish),
 * session name from the tail. Claude writes `custom-title` entries
 * throughout the session (name set via `--name`, `/name`, or UI), so the
 * latest one closest to EOF is authoritative. For long sessions the
 * entries can live millions of bytes past the 8 KB header, and a fixed
 * tail window can miss them if the name was set once and then not
 * rewritten. The tail scan expands in 64 KB chunks from EOF backwards
 * until a match is found or we've read the whole file.
 * Estimates message count from file size instead of counting newlines.
 */
function readSessionMeta(path: string, sizeBytes: number): { summary: string | null; sessionName: string | null; messageCount: number | null } {
  const HEAD = 8192
  const TAIL_CHUNK = 65536
  let summary: string | null = null
  let sessionName: string | null = null
  try {
    const fd = openSync(path, 'r')
    try {
      const headBuf = Buffer.alloc(HEAD)
      const headN = readSync(fd, headBuf, 0, HEAD, 0)
      for (const line of headBuf.slice(0, headN).toString('utf-8').split('\n')) {
        if (!line.trim()) continue
        try {
          const obj = JSON.parse(line) as { type?: string; summary?: string; customTitle?: string; agentName?: string }
          if (typeof obj.summary === 'string' && !summary) summary = obj.summary
          if (obj.type === 'custom-title' && typeof obj.customTitle === 'string') sessionName = obj.customTitle
          else if (obj.type === 'agent-name' && typeof obj.agentName === 'string' && !sessionName) sessionName = obj.agentName
        } catch { /* skip non-JSON lines */ }
      }

      // Scan tail in 64 KB chunks from EOF backwards until we find a
      // custom-title / agent-name or exhaust the file. Each chunk is
      // parsed bottom-to-top so the latest entry wins — as soon as the
      // first match appears we stop. Stops early on the common case
      // (claude rewrites the title frequently); in the pathological
      // case where the name was set once at resume and never touched
      // again, we may end up reading the whole file.
      let windowEnd = sizeBytes
      let carry = '' // partial line from the previous (higher-offset) chunk
      while (windowEnd > 0 && !sessionName) {
        const chunkSize = Math.min(TAIL_CHUNK, windowEnd)
        const chunkStart = windowEnd - chunkSize
        const buf = Buffer.alloc(chunkSize)
        readSync(fd, buf, 0, chunkSize, chunkStart)
        const text = buf.toString('utf-8') + carry
        const nl = text.indexOf('\n')
        // If this isn't the first chunk from the top, the head of `text`
        // is likely a truncated line — defer it to the next iteration.
        const head = chunkStart > 0 && nl >= 0 ? text.slice(0, nl) : ''
        const body = chunkStart > 0 && nl >= 0 ? text.slice(nl + 1) : text
        const lines = body.split('\n')
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i]
          if (!line.trim()) continue
          try {
            const obj = JSON.parse(line) as { type?: string; customTitle?: string; agentName?: string }
            if (obj.type === 'custom-title' && typeof obj.customTitle === 'string') {
              sessionName = obj.customTitle
              break
            }
            if (obj.type === 'agent-name' && typeof obj.agentName === 'string') {
              sessionName = obj.agentName
              break
            }
          } catch { /* skip non-JSON lines */ }
        }
        carry = head
        windowEnd = chunkStart
      }
    } finally {
      closeSync(fd)
    }
  } catch { /* ignore */ }
  const messageCount = sizeBytes > 0 ? Math.max(1, Math.round(sizeBytes / 400)) : null
  return { summary, sessionName, messageCount }
}

/**
 * Read the first ~16 KB of a session file and return the original `cwd`
 * recorded on a user/assistant turn (lossless, unlike the reverse of the
 * project-hash dir). Returns null if no cwd field is found.
 */
function readSessionCwd(path: string): string | null {
  try {
    const fd = openSync(path, 'r')
    try {
      const buf = Buffer.alloc(16384)
      const n = readSync(fd, buf, 0, 16384, 0)
      const head = buf.slice(0, n).toString('utf-8')
      for (const line of head.split('\n')) {
        if (!line.trim()) continue
        try {
          const obj = JSON.parse(line) as { cwd?: string }
          if (typeof obj.cwd === 'string' && obj.cwd.startsWith('/')) return obj.cwd
        } catch { /* skip non-JSON lines */ }
      }
    } finally {
      closeSync(fd)
    }
  } catch { /* ignore */ }
  return null
}

/**
 * Attach an existing claude session UUID to a DC chat. The `.jsonl`
 * file stays in its origin project-hash dir — the subagent will spawn
 * with cwd = that same dir so `--resume <uuid>` finds the file on the
 * first try and terminal/DC share a single on-disk source of truth.
 * Records the origin cwd as `workingDir` on the binding. Preserves
 * existing binding fields (agentId, inheritClaudeMd, createdAt).
 *
 * Throws if the session isn't found on disk or is already bound to
 * another DC chat.
 */
export async function attachSessionToChat(
  chatId: number,
  sessionId: string,
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

  // Prefer the cwd recorded inline in the .jsonl (lossless) over the
  // reverse of the project-hash dir name (lossy when paths contain `-`).
  // The subagent spawns in this dir; a wrong path would leave claude
  // unable to `cd` into it.
  const srcProjectDir = dirname(srcPath)
  const srcHashName = srcProjectDir.slice(PROJECTS_ROOT.length + 1)
  const workingDir = readSessionCwd(srcPath) ?? cwdFromProjectHash(srcHashName)

  const existing = bindings.getBinding(chatId)
  bindings.saveBinding({
    chatId,
    agentId: existing?.agentId,
    inheritClaudeMd: existing?.inheritClaudeMd,
    sessionId,
    workingDir,
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

/**
 * Read the last ~32 KB of a session file and extract text content from
 * recent user/assistant turns. Returns a condensed string suitable for
 * feeding to an LLM to generate a summary and chat title.
 */
export function readRecentTurns(sessionId: string, maxBytes: number = 32768): string {
  const path = findSessionFile(sessionId)
  if (!path) return ''

  let size: number
  try { size = statSync(path).size } catch { return '' }
  if (size === 0) return ''

  const readSize = Math.min(size, maxBytes)
  const offset = Math.max(0, size - readSize)

  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(readSize)
    readSync(fd, buf, 0, readSize, offset)
    const raw = buf.toString('utf-8')

    const lines = raw.split('\n').filter(Boolean)
    const turns: string[] = []
    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as { type?: string; message?: unknown }
        if (obj.type !== 'user' && obj.type !== 'assistant') continue
        const msg = obj.message
        if (!msg) continue
        let text = ''
        if (typeof msg === 'string') {
          text = msg
        } else if (Array.isArray(msg)) {
          text = (msg as Array<{ type?: string; text?: string }>)
            .filter(b => b.type === 'text' && b.text)
            .map(b => b.text!)
            .join('\n')
        } else if (typeof msg === 'object' && 'content' in (msg as object)) {
          const c = (msg as { content?: string }).content
          if (typeof c === 'string') text = c
        }
        if (text.trim()) {
          turns.push(`[${obj.type}]: ${text.slice(0, 500)}`)
        }
      } catch { /* skip malformed lines */ }
    }
    return turns.slice(-20).join('\n\n')
  } finally {
    closeSync(fd)
  }
}
