/**
 * Per-chat persistent claude session id store.
 *
 * One subagent is bound 1:1 to a chat. We want a stable session id per
 * chat that survives across subagent process deaths (idle timeout, LRU
 * eviction, crash respawn) so the next spawn can `--resume <id>` and
 * pick up the prior in-process turn history (TodoWrites, plans,
 * intermediate tool outputs) — none of which is recoverable from
 * `dc_chat_history` alone.
 *
 * Storage: one JSON file per chat under <baseDir>/<chatId>.json.
 * Sessions are deleted when the chat is unpaired (server.ts cleanupChat).
 */
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface SessionRecord {
  sessionId: string
  createdAt: number
}

export class SessionStore {
  constructor(private baseDir: string) {
    mkdirSync(baseDir, { recursive: true })
  }

  private pathFor(chatId: number): string {
    return join(this.baseDir, `${chatId}.json`)
  }

  /** Return the stored session id for a chat, or null if none. */
  load(chatId: number): SessionRecord | null {
    const p = this.pathFor(chatId)
    if (!existsSync(p)) return null
    try {
      const raw = readFileSync(p, 'utf-8')
      const parsed = JSON.parse(raw) as Partial<SessionRecord>
      if (typeof parsed.sessionId !== 'string' || parsed.sessionId.length === 0) return null
      return {
        sessionId: parsed.sessionId,
        createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : Date.now(),
      }
    } catch {
      return null
    }
  }

  /** Persist a session id for a chat. Overwrites any existing record. */
  save(chatId: number, sessionId: string): SessionRecord {
    const rec: SessionRecord = { sessionId, createdAt: Date.now() }
    writeFileSync(this.pathFor(chatId), JSON.stringify(rec), { mode: 0o600 })
    return rec
  }

  /** Get the existing session id, or create+persist a fresh one. */
  loadOrCreate(chatId: number): { record: SessionRecord; created: boolean } {
    const existing = this.load(chatId)
    if (existing) return { record: existing, created: false }
    return { record: this.save(chatId, randomUUID()), created: true }
  }

  /** Delete the stored session id for a chat. No-op if absent. */
  delete(chatId: number): void {
    try { unlinkSync(this.pathFor(chatId)) } catch {}
  }
}
