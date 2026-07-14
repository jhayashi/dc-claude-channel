/**
 * Persistent card-session store (#114 P3). The central webxdcAppRegistry
 * and every card's module-level msgId→chatId map are in-memory, so each
 * dispatcher restart silently killed every open card. This store is the
 * single durable record both restore from at boot.
 *
 * Safety invariant: lastSerial lives in the SAME record as the session —
 * registry restoration can never outrun serial restoration, so a restored
 * card never replays old state-changing updates.
 *
 * Generalizes the file-reviewer's existing per-chat persistence pattern
 * (file-reviewer.ts), which stays authoritative for its richer state.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export interface CardSessionRecord {
  appId: string
  chatId: number
  lastSerial: number
  createdAt: string
}

let DIR = join(homedir(), '.claude', 'channels', 'deltachat')

export function setCardSessionsDir(dir: string): void { DIR = dir }

function filePath(): string { return join(DIR, 'card-sessions.json') }

export function loadCardSessions(): Record<string, CardSessionRecord> {
  try {
    return JSON.parse(readFileSync(filePath(), 'utf-8')) as Record<string, CardSessionRecord>
  } catch {
    return {}
  }
}

function save(all: Record<string, CardSessionRecord>): void {
  mkdirSync(DIR, { recursive: true })
  const tmp = `${filePath()}.tmp.${process.pid}`
  writeFileSync(tmp, JSON.stringify(all))
  renameSync(tmp, filePath())
}

export function recordCardSession(msgId: number, appId: string, chatId: number): void {
  const all = loadCardSessions()
  const existing = all[String(msgId)]
  all[String(msgId)] = {
    appId, chatId,
    lastSerial: existing?.lastSerial ?? 0,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  }
  save(all)
}

export function updateCardSerial(msgId: number, lastSerial: number): void {
  const all = loadCardSessions()
  const rec = all[String(msgId)]
  if (!rec) return
  if (lastSerial <= rec.lastSerial) return
  rec.lastSerial = lastSerial
  save(all)
}

export function pruneCardSessions(keep = 100): void {
  const all = loadCardSessions()
  const entries = Object.entries(all)
  if (entries.length <= keep) return
  entries.sort((a, b) =>
    a[1].createdAt === b[1].createdAt
      ? Number(a[0]) - Number(b[0])
      : a[1].createdAt.localeCompare(b[1].createdAt))
  const kept = entries.slice(entries.length - keep)
  save(Object.fromEntries(kept))
}

/** Boot-time restore. Returns how many sessions were restored. */
export function restoreCardSessions(deps: {
  apps: ReadonlyArray<{ id: string; restoreSession?: (msgId: number, chatId: number) => void }>
  register: (msgId: number, appId: string, chatId: number, lastSerial: number) => void
}): number {
  const all = loadCardSessions()
  let restored = 0
  for (const [msgIdStr, rec] of Object.entries(all)) {
    const app = deps.apps.find(a => a.id === rec.appId)
    if (!app) continue
    const msgId = Number(msgIdStr)
    deps.register(msgId, rec.appId, rec.chatId, rec.lastSerial)
    app.restoreSession?.(msgId, rec.chatId)
    restored++
  }
  return restored
}

/**
 * Expired fallback: an update for a msgId nobody knows (pre-persistence
 * card, pruned entry). Notifies the chat once per msgId; degrades to a
 * silent skip when the chat can't be resolved.
 */
export async function handleUnknownCardUpdate(msgId: number, deps: {
  resolveChatId: (msgId: number) => Promise<number | null>
  send: (chatId: number, text: string) => Promise<unknown>
  notified: Set<number>
}): Promise<boolean> {
  if (deps.notified.has(msgId)) return false
  deps.notified.add(msgId)
  const chatId = await deps.resolveChatId(msgId).catch(() => null)
  if (chatId === null) return false
  await deps.send(chatId, 'That card is from an older session and has expired — ask me to send a fresh one.').catch(() => {})
  return true
}
