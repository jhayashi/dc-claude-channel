/**
 * Binding registry — host-local, per-chat records that link a DC chat
 * to an agent definition and hold the runtime state (claude session
 * UUID for --resume, inheritClaudeMd flag).
 *
 * State stored in ~/.claude/channels/deltachat/bindings/<chatId>.json.
 * Bindings replace the old GroupContext store and absorb the old
 * SessionStore — the claude session UUID now lives on the binding.
 *
 * A binding may exist without an agentId (e.g. a chat whose first
 * subagent spawned before the user completed agent setup). In that
 * case the subagent runs with default model/prompt. Once the user
 * finishes setup, bindAgent() populates agentId and inheritClaudeMd.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import * as agents from './agents.js'
import type { AgentDef } from './agents.js'

let BINDINGS_DIR = join(homedir(), '.claude', 'channels', 'deltachat', 'bindings')

/** Override the storage directory (for tests). */
export function setBindingsDir(dir: string): void {
  BINDINGS_DIR = dir
}

export const BindingSchema = z.object({
  chatId: z.number(),
  agentId: z.string().optional(),
  sessionId: z.string().optional(),
  inheritClaudeMd: z.boolean().optional(),
  /**
   * Working directory the subagent is spawned in for this chat, and the
   * cwd emitted by dc_resume_in_terminal. Set on first spawn (to the
   * dispatcher's process.cwd() for DC-native chats) or on
   * resume.attachSessionToChat (to the origin cwd of a terminal session
   * being pulled in). Determines which project-hash dir the session's
   * .jsonl lives in — terminal and DC both read/write the same file.
   */
  workingDir: z.string().optional(),
  createdAt: z.string(),
})

export type Binding = z.infer<typeof BindingSchema>

function bindingPath(chatId: number): string {
  return join(BINDINGS_DIR, `${chatId}.json`)
}

/** List all bindings on disk. Invalid files are skipped. */
export function listBindings(): Binding[] {
  if (!existsSync(BINDINGS_DIR)) return []
  const out: Binding[] = []
  for (const entry of readdirSync(BINDINGS_DIR)) {
    if (!entry.endsWith('.json')) continue
    const chatId = Number(entry.slice(0, -'.json'.length))
    if (!Number.isFinite(chatId)) continue
    const b = getBinding(chatId)
    if (b) out.push(b)
  }
  return out.sort((a, b) => a.chatId - b.chatId)
}

/** Count how many bindings reference the given agentId. */
export function countByAgentId(agentId: string): number {
  return listBindings().filter((b) => b.agentId === agentId).length
}

/** Get a single binding by chatId. Returns null if missing or invalid. */
export function getBinding(chatId: number): Binding | null {
  const path = bindingPath(chatId)
  if (!existsSync(path)) return null
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return null
  }
  const parsed = BindingSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/** Save a binding. Atomic via temp + rename. */
export function saveBinding(binding: Binding): void {
  const validated = BindingSchema.parse(binding)
  mkdirSync(BINDINGS_DIR, { recursive: true })
  const finalPath = bindingPath(validated.chatId)
  const tmpPath = `${finalPath}.tmp.${process.pid}`
  writeFileSync(tmpPath, JSON.stringify(validated, null, 2), { mode: 0o600 })
  renameSync(tmpPath, finalPath)
}

/** Delete a binding. Returns true if a file was removed. */
export function deleteBinding(chatId: number): boolean {
  const path = bindingPath(chatId)
  if (!existsSync(path)) return false
  unlinkSync(path)
  return true
}

/**
 * Resolve a chat to its bound agent definition. Returns null if no
 * binding exists, the binding has no agentId, or the referenced agent
 * definition is missing.
 */
export function resolveChat(chatId: number): { binding: Binding; agent: AgentDef } | null {
  const binding = getBinding(chatId)
  if (!binding?.agentId) return null
  const agent = agents.getAgent(binding.agentId)
  if (!agent) return null
  return { binding, agent }
}

/**
 * Get the persistent claude session UUID for a chat, creating one if
 * absent. Creates a minimal binding (no agentId) on first call if none
 * exists. Mirrors the old SessionStore.loadOrCreate semantics.
 */
export function loadOrCreateSessionId(chatId: number): { sessionId: string; created: boolean } {
  let binding = getBinding(chatId)
  if (binding?.sessionId) {
    return { sessionId: binding.sessionId, created: false }
  }
  const sessionId = randomUUID()
  if (!binding) {
    binding = {
      chatId,
      sessionId,
      createdAt: new Date().toISOString(),
    }
  } else {
    binding = { ...binding, sessionId }
  }
  saveBinding(binding)
  return { sessionId, created: true }
}

/** Drop the stored session UUID from a chat's binding (resume-fallback). */
export function clearSessionId(chatId: number): void {
  const binding = getBinding(chatId)
  if (!binding) return
  const { sessionId: _dropped, ...rest } = binding
  saveBinding(rest as Binding)
}

/**
 * Bind an agent to a chat. Creates a new binding or updates an existing
 * one, preserving sessionId and createdAt. Used by the WebXDC setup
 * flow after the user picks or creates an agent.
 */
export function bindAgent(
  chatId: number,
  agentId: string,
  opts: { inheritClaudeMd: boolean },
): Binding {
  const existing = getBinding(chatId)
  const binding: Binding = {
    chatId,
    agentId,
    inheritClaudeMd: opts.inheritClaudeMd,
    sessionId: existing?.sessionId,
    workingDir: existing?.workingDir,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  }
  saveBinding(binding)
  return binding
}
