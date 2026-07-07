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
import * as access from './access/index.js'
import * as sessionAgents from './session-agents.js'

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

/**
 * Count how many *live* bindings reference the given agentId — i.e.,
 * bindings whose chat is still approved (in the access list). Orphan
 * binding files (chat left/deleted without cleanup) are excluded so
 * the manage-agents UI sees the true chat count, not stale disk state.
 */
export function countByAgentId(agentId: string): number {
  return listBindings().filter((b) => b.agentId === agentId && access.isAllowed(b.chatId)).length
}

/**
 * v1.4.9 — resolve the agent context for a chat.
 *
 * THE invariant for per-agent contacts/capability lookups (plan Phase 0.2):
 * the agent context for any contact decision is the agent that owns the
 * chat where the contact is acting (or being managed for), NOT the
 * asking subagent's own agent. This helper is the *only* sanctioned
 * fallback to claude-code in production code — every other read of the
 * default-agent constant outside the contacts/pairing/chat-allowlist
 * internals is treated as a bug by the CI grep guard
 * (scripts/check-no-default-agent-id.sh).
 *
 * Returns the binding's agentId if present, otherwise DEFAULT_AGENT_ID.
 * Unbound chats (no binding file) and bindings without an agentId (chat
 * paired but agent-setup not yet completed) both fall back to claude-
 * code — that preserves pre-v1.4.9 behavior for those edge cases while
 * routing every "happy path" lookup to the correct per-agent sidecar.
 *
 * Callers: server.ts dispatch/capability gate, dc-tools.ts trust filter,
 * agent-setup-app.ts contacts UI handlers. See the plan for the full
 * sweep table.
 */
export function getBindingAgentId(chatId: number): string {
  return getBinding(chatId)?.agentId ?? agents.DEFAULT_AGENT_ID
}

/**
 * v1.4.9 — list every agent that *might* have contact records.
 *
 * Returns the union of DEFAULT_AGENT_ID (the canonical claude-code
 * sidecar, terminal-pair target and canonical-seed source) and every
 * bound agent currently referenced by a binding. Used by two patterns:
 *
 *   - **Unpair across all sidecars** (dc_access_unpair, server.ts):
 *     "remove this contact's permission to interact with the bot"
 *     means removing their record from every agent that holds one —
 *     including orphan sidecars where the agent .md is gone. Pass no
 *     filter so orphan sidecars get swept too.
 *
 *   - **Startup backfill** (backfillFromAllowlist, server.ts): legacy
 *     installs need a record written under each bound agent's sidecar.
 *     Pass `agentExists` so the backfill skips orphan-binding agentIds
 *     (whose .md was deleted without sweeping the binding) — otherwise
 *     the backfill creates litter files in <orphan>.dc/contacts/ that
 *     no agent can ever read. Mirrors the canonical-seed migration's
 *     orphaned_binding skip-and-log.
 *
 * DEFAULT_AGENT_ID is always included regardless of the filter —
 * claude-code is the canonical pairing-target invariant even if
 * claude-code.md itself were somehow missing (degenerate case).
 *
 * Performance: cheap — one disk scan over the bindings/ dir + a Set
 * dedup. Called at startup and on owner-driven unpair, not in the hot
 * dispatch loop.
 */
export function listAllAgentIds(opts?: {
  /** Optional predicate that filters bound agentIds. Returning false on a bound agentId omits it from the result. The default (claude-code) is always included regardless. */
  agentExists?: (agentId: string) => boolean
}): Set<string> {
  const out = new Set<string>([agents.DEFAULT_AGENT_ID])
  for (const b of listBindings()) {
    if (!b.agentId) continue
    if (opts?.agentExists) {
      // v1.4.9 Oliver P2 (2026-05-31): agentExists is wired in production
      // to `(aid) => agents.getAgent(aid) !== null`, which reads
      // ~/.claude/agents/<aid>.md from disk. Transient filesystem errors
      // (EACCES, EBADF) would throw out of the callback and abort the
      // entire iteration uncaught — caught only by callers' outer try,
      // with no per-binding evidence. Same per-binding-isolation pattern
      // as the Phase 1 fix in migrateContactsCanonicalSeed.
      let exists = false
      try {
        exists = opts.agentExists(b.agentId)
      } catch (err) {
        console.error(
          `bindings.listAllAgentIds: agentExists(${b.agentId}) threw, skipping:`,
          err,
        )
        continue
      }
      if (!exists) continue
    }
    out.add(b.agentId)
  }
  return out
}

/**
 * Delete binding files whose chat is no longer in the access list.
 * Called once at dispatcher startup. Returns the number of files
 * removed (for logging).
 */
export function sweepOrphans(): number {
  let removed = 0
  for (const b of listBindings()) {
    if (!access.isAllowed(b.chatId)) {
      if (deleteBinding(b.chatId)) removed++
    }
  }
  return removed
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

// A workingDir is a "plugin-cache-version path" when it lives under
// .../plugins/cache/<marketplace>/deltachat/<version>[/...]. Claude Code
// prunes old <version> dirs on plugin auto-update, orphaning any binding
// whose workingDir was pinned to one. Matching the `deltachat` plugin
// segment keeps this from healing an unrelated plugin's cache path.
const PLUGIN_CACHE_VERSION_RE = /[\\/]plugins[\\/]cache[\\/][^\\/]+[\\/]deltachat[\\/][^\\/]+/

export function isPluginCacheVersionPath(dir: string): boolean {
  return PLUGIN_CACHE_VERSION_RE.test(dir)
}

export type SpawnCwdResolution =
  | { kind: 'ok'; workingDir: string }
  | { kind: 'adopt'; workingDir: string }
  | { kind: 'healed'; workingDir: string; healedFrom: string }
  | { kind: 'unresolvable'; missingDir: string }

/**
 * Resolve the cwd to spawn a subagent in. Discriminates missing-dir cases:
 *  - no recorded dir (brand-new chat) → adopt the dispatcher's cwd.
 *  - recorded dir exists → use it.
 *  - recorded dir gone AND it's a pruned plugin-cache-version path → heal to
 *    the running dispatcher's own plugin dir (same path, live version). This
 *    is the #126 auto-update case.
 *  - recorded dir gone otherwise (deleted worktree, moved project) →
 *    unresolvable; the caller surfaces a chat error rather than silently
 *    running the agent in the wrong place.
 * Pure: `dirExists` is injected so it unit-tests without the filesystem.
 */
export function resolveSpawnCwd(
  workingDir: string | undefined,
  deps: { fallbackCwd: string; currentPluginDir: string; dirExists: (p: string) => boolean },
): SpawnCwdResolution {
  const { fallbackCwd, currentPluginDir, dirExists } = deps
  if (!workingDir) return { kind: 'adopt', workingDir: fallbackCwd }
  if (dirExists(workingDir)) return { kind: 'ok', workingDir }
  if (isPluginCacheVersionPath(workingDir) && dirExists(currentPluginDir)) {
    return { kind: 'healed', workingDir: currentPluginDir, healedFrom: workingDir }
  }
  return { kind: 'unresolvable', missingDir: workingDir }
}

/** Save a binding. Atomic via temp + rename. */
export function saveBinding(binding: Binding): void {
  const validated = BindingSchema.parse(binding)
  mkdirSync(BINDINGS_DIR, { recursive: true })
  const finalPath = bindingPath(validated.chatId)
  const tmpPath = `${finalPath}.tmp.${process.pid}`
  writeFileSync(tmpPath, JSON.stringify(validated, null, 2), { mode: 0o600 })
  renameSync(tmpPath, finalPath)
  if (validated.sessionId && validated.agentId) {
    sessionAgents.setAgentForSession(validated.sessionId, validated.agentId)
  }
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
  // Heal-on-bind: re-save the agent definition so saveAgent auto-injects
  // mcp__dc into tools if absent. Terminal-CC agents (and any hand-edited
  // .md) likely lack mcp__dc; without this, the next dispatch would hit
  // the spawn-time refusal in subagent-cache. Silent no-op if the agent
  // is missing — that path is exercised by other code (e.g. resolveChat).
  const def = agents.getAgent(agentId)
  if (def) agents.saveAgent(def)
  return binding
}
