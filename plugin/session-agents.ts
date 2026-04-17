/**
 * Persistent sessionId → agentId reverse index.
 *
 * Written whenever a session is bound to an agent (via bindings.saveBinding).
 * Read by resume_attach to recover the original agent when a session crosses
 * the DC↔terminal boundary. Survives binding deletion so the mapping is
 * available when a session returns to DC.
 *
 * Stored as: ~/.claude/channels/deltachat/session-agents.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

let INDEX_DIR = join(homedir(), '.claude', 'channels', 'deltachat')
let cache: Record<string, string> | null = null

export function setIndexDir(dir: string): void {
  INDEX_DIR = dir
  cache = null
}

function indexPath(): string {
  return join(INDEX_DIR, 'session-agents.json')
}

function load(): Record<string, string> {
  if (cache) return cache
  const p = indexPath()
  if (!existsSync(p)) {
    cache = {}
    return cache
  }
  try {
    const raw = JSON.parse(readFileSync(p, 'utf-8'))
    cache = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}
  } catch {
    cache = {}
  }
  return cache
}

function persist(): void {
  const data = load()
  mkdirSync(INDEX_DIR, { recursive: true })
  const p = indexPath()
  const tmp = `${p}.tmp.${process.pid}`
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  renameSync(tmp, p)
}

export function getAgentForSession(sessionId: string): string | null {
  return load()[sessionId] ?? null
}

export function setAgentForSession(sessionId: string, agentId: string): void {
  load()[sessionId] = agentId
  persist()
}

export function removeSession(sessionId: string): void {
  const data = load()
  if (sessionId in data) {
    delete data[sessionId]
    persist()
  }
}
