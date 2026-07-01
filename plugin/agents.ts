/**
 * Agent definition registry — portable agent definitions stored as
 * Claude Code's `~/.claude/agents/<name>.md` format: YAML frontmatter +
 * markdown body. The body is the agent's system prompt. DC-specific
 * fields use the `x-dc-` frontmatter prefix (CC ignores unknown keys).
 *
 * Each agent's `name` is the canonical identifier (also the filename
 * stem). Bindings reference agents by name. Agents are reusable —
 * multiple chat bindings may point to the same agent definition.
 *
 * DC-private per-agent state (contacts, chatmail, …) lives in a
 * sibling directory `~/.claude/agents/<name>.dc/` — owned by
 * `access/contacts.ts`, opaque to this module.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { parseAgentMarkdown, serializeAgentMarkdown } from './agent-md.js'
import * as models from './models.js'
import {
  ARCHETYPE_PALETTES,
  ARCHETYPE_DEFAULT_GLYPH,
  PATTERN_IDS,
  randomPatternId,
  type PatternId,
} from './agent-icons/palettes.js'

let AGENTS_DIR = join(homedir(), '.claude', 'agents')

/** Override the storage directory (for tests). */
export function setAgentsDir(dir: string): void {
  AGENTS_DIR = dir
}

/** Return the current agents storage directory (for tests). */
export function getAgentsDir(): string {
  return AGENTS_DIR
}

/**
 * Allowed model ids for agent definitions. Sourced from the models
 * manifest (plugin/models.json) so adding a new model only requires
 * editing JSON + restarting the dispatcher.
 */
export const ALLOWED_MODELS: readonly string[] = models.MODEL_IDS
export type AllowedModel = string

/** Default system prompt for newly created agents. */
export const DEFAULT_SYSTEM_PROMPT =
  'You are a helpful assistant in this chat. Match the tone of the conversation.'

/** Default model for newly created agents. */
export const DEFAULT_MODEL: string = models.DEFAULT_MODEL

/**
 * Sentinel name for the built-in default agent. This agent is always
 * present (auto-seeded by listAgents / ensureDefaultAgent) and cannot
 * be deleted (deleteAgent throws on this name). Its model / prompt /
 * x-dc-* metadata is editable — only the name and its existence are
 * immutable.
 */
export const DEFAULT_AGENT_ID = 'claude-code'

/** Whether an agent name is the undeletable built-in default. */
export function isUndeletableAgent(name: string): boolean {
  return name === DEFAULT_AGENT_ID
}

/**
 * Ensure the built-in default agent exists on disk, writing a seed
 * definition if it doesn't. Returns the current (possibly user-edited)
 * agent definition. Safe to call repeatedly; existing edits are
 * preserved.
 */
export function ensureDefaultAgent(): AgentDef {
  const existing = getAgent(DEFAULT_AGENT_ID)
  if (existing) return existing
  const seed: AgentDef = {
    name: DEFAULT_AGENT_ID,
    description: '',
    model: DEFAULT_MODEL,
    tools: 'Read, Edit, Write, Bash, Grep, Glob, mcp__dc',
    permissionMode: 'bypassPermissions',
    memory: 'user',
    body: DEFAULT_SYSTEM_PROMPT,
  }
  saveAgent(seed)
  return seed
}

/**
 * Whether an agent should inherit the dispatcher's CLAUDE.md.
 * Delegates to the models manifest (haiku skips it; others include it).
 */
export const inheritClaudeMdForModel = models.inheritClaudeMdForModel

/**
 * Agent definition schema — matches Claude Code's `~/.claude/agents/<name>.md`
 * frontmatter shape. The markdown body is held in `body`. DC-only fields
 * use the `x-dc-` prefix (CC silently ignores unknown frontmatter keys).
 *
 * Pass-through fields (skills, hooks, maxTurns, background, isolation,
 * initialPrompt) are preserved on read/write but not acted on by DC's
 * long-lived per-chat lifecycle. They're meaningful when the same file
 * is used from terminal CC.
 */
/**
 * `tools` / `disallowedTools` field schema. CC documents two on-disk
 * forms (CSV string OR YAML list of strings); we accept both and
 * normalise to a CSV string for the in-memory shape. saveAgent writes
 * back as CSV. The required `tools` field defaults to `''` when absent;
 * `disallowedTools` stays `undefined` when absent (no default).
 */
const ToolsField = z.union([z.string(), z.array(z.string())])
  .transform(v => Array.isArray(v) ? v.join(', ') : v)

export const AgentDefSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'name must be a lowercase slug').max(64),
  description: z.string().max(2048).default(''),
  model: z.string().refine(
    // Accept manifest-known ids AND custom claude-<tier>-* ids (v1.4.11) so a
    // future/preview model doesn't fail to load and brick the bound chats.
    // Non-claude garbage is still rejected. See models.isAcceptableModelId.
    (v): v is string => models.isAcceptableModelId(v),
    v => ({ message: `Unsupported model "${v}". Use a known id (${ALLOWED_MODELS.join(', ')}) or a custom claude-<tier>-… id.` }),
  ),
  tools: ToolsField.default(''),
  disallowedTools: ToolsField.optional(),
  permissionMode: z.enum([
    'default', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions', 'plan',
  ]).optional(),
  effort: z.enum(models.EFFORT_LEVELS).optional(),
  memory: z.enum(['user', 'project', 'local']).optional(),
  mcpServers: z.array(z.unknown()).optional(),
  color: z.string().optional(),
  // CC pass-through (preserved on round-trip; DC does not act on these)
  skills: z.array(z.unknown()).optional(),
  hooks: z.record(z.string(), z.unknown()).optional(),
  maxTurns: z.number().int().positive().optional(),
  background: z.boolean().optional(),
  isolation: z.string().optional(),
  initialPrompt: z.string().optional(),
  // DC-only extensions (frontmatter top-level)
  'x-dc-archetype': z.enum(['role', 'utility', 'project']).optional(),
  'x-dc-icon': z.string().optional(),
  'x-dc-glyph': z.string().optional(),
  'x-dc-pattern': z.string().optional(),
  'x-dc-icon-mirror': z.boolean().optional(),
  'x-dc-display-name': z.string().max(256).optional(),
  'x-dc-memory-boost': z.enum(['on', 'off']).optional(),
  // Markdown body — the agent's system prompt.
  body: z.string().max(100_000).default(''),
}).passthrough()  // Preserve forward-compat for CC fields we don't yet know about.

export type AgentDef = z.infer<typeof AgentDefSchema>

/**
 * Draft agent — same shape as AgentDef but without a name. Used in the
 * WebXDC setup flow where the user edits a draft before committing, at
 * which point the name is synthesized from the human display name.
 */
export const DraftAgentSchema = AgentDefSchema.omit({ name: true })
export type DraftAgent = z.infer<typeof DraftAgentSchema>

/**
 * v1.4 on-disk layout. The agent definition lives in a single markdown
 * file alongside terminal CC's own agents; DC-private sidecar state
 * (contacts/, chatmail/) lives in a sibling directory named `<name>.dc/`.
 *
 *   ~/.claude/agents/<name>.md             — agent definition (this file)
 *   ~/.claude/agents/<name>.dc/contacts/   — DC trust annotations
 *   ~/.claude/agents/<name>.dc/chatmail/   — managed-agent chatmail state (v1.4+)
 *   ~/.claude/agent-memory/<name>/MEMORY.md — CC-owned persistent memory
 *
 * `agentPath(name)` is the canonical .md path; the sidecar dir is owned
 * by contacts.ts and not exposed from this module.
 */
function agentPath(name: string): string {
  return join(AGENTS_DIR, `${name}.md`)
}

/**
 * Walk every `<name>.dc/` sidecar directory under AGENTS_DIR and report
 * any `.md` files found inside. CC's recursive scan of ~/.claude/agents/
 * would pick those up as agents — we want them ignored (and the
 * operator notified). Returns the list of stray paths for logging.
 *
 * Dispatcher startup calls this and logs the result. The write path
 * never produces stray .md (contacts.writeContact only emits .json), so
 * any hits represent operator hand-edits or migration artifacts.
 */
export function lintSidecarDirs(): string[] {
  if (!existsSync(AGENTS_DIR)) return []
  const stray: string[] = []
  for (const entry of readdirSync(AGENTS_DIR)) {
    if (!entry.endsWith('.dc')) continue
    const sidecar = join(AGENTS_DIR, entry)
    walkForMarkdown(sidecar, stray)
  }
  return stray
}

function walkForMarkdown(dir: string, out: string[]): void {
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return }
  for (const e of entries) {
    const p = join(dir, e)
    let isDir = false
    try { isDir = statSync(p).isDirectory() } catch { continue }
    if (isDir) { walkForMarkdown(p, out); continue }
    if (e.endsWith('.md')) out.push(p)
  }
}

/**
 * List all agent definitions on disk, sorted by name. Invalid files
 * skipped. Auto-seeds the built-in default agent (DEFAULT_AGENT_ID) if
 * it's missing, so the agent list is never empty.
 *
 * Scans for `*.md` entries — sidecar directories (`<name>.dc/`) and any
 * other files are ignored.
 */
export function listAgents(): AgentDef[] {
  mkdirSync(AGENTS_DIR, { recursive: true })
  ensureDefaultAgent()
  const out: AgentDef[] = []
  for (const entry of readdirSync(AGENTS_DIR)) {
    if (!entry.endsWith('.md')) continue
    const name = entry.slice(0, -'.md'.length)
    const agent = getAgent(name)
    if (agent) out.push(agent)
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** Get a single agent by name. Returns null if missing or invalid. */
export function getAgent(name: string): AgentDef | null {
  const path = agentPath(name)
  if (!existsSync(path)) return null
  let parsed: { frontmatter: Record<string, unknown>; body: string }
  try {
    parsed = parseAgentMarkdown(readFileSync(path, 'utf-8'))
  } catch {
    return null
  }
  const combined = { ...parsed.frontmatter, body: parsed.body }
  const result = AgentDefSchema.safeParse(combined)
  return result.success ? result.data : null
}

/**
 * The set of DC tool names registered by the dispatcher (core registry in
 * dispatcher/dc-tools.ts + apps' tool registrations). Used by `ensureMcpDc`
 * to expand the bare `mcp__dc` server prefix into specific `mcp__dc__<tool>`
 * entries.
 *
 * Why expansion is necessary: CC's frontmatter `tools:` parser treats
 * `mcp__<server>` as the *name* of a tool to allow (not a wildcard), so an
 * agent whose .md only carries the prefix loses access to every concrete
 * MCP tool at runtime ("Claude requested permissions to use
 * mcp__dc__<tool>, but you haven't granted it yet"). The CLI `--allowed-
 * tools` flag *does* treat the prefix as a wildcard, but DC also wants the
 * .md to be portable to terminal CC's Task delegation path where the
 * frontmatter is the only allowlist source.
 *
 * The set is injected once at dispatcher boot from the live registrations
 * (see `setDcToolNames` in server.ts `main()`) so it can never drift from
 * what the dispatcher actually serves. Empty until injected; the boot call
 * MUST run before any `saveAgent`/`ensureMcpDc` (notably the v1.4 migration).
 */
let _dcToolNames: readonly string[] = []
/** Set once at dispatcher boot from the live tool registrations (core registry + apps). */
export function setDcToolNames(names: readonly string[]): void {
  _dcToolNames = [...new Set(names)].sort()
}
export function getDcToolNames(): readonly string[] {
  return _dcToolNames
}
/**
 * Ensure DC tools are present in a tools CSV. The DC tools-proxy MCP
 * server is mandatory — without `mcp__dc__<tool>` entries the agent
 * has no `dc_reply` / `dc_react` / etc.
 *
 * Two-tier behavior:
 *   - If any specific `mcp__dc__<tool>` is already present, leave the CSV
 *     alone (user is opting into a narrow surface).
 *   - Otherwise, drop the bare `mcp__dc` prefix (it doesn't work as a
 *     wildcard in CC's frontmatter parsing) and emit the full set
 *     injected at boot via `setDcToolNames`.
 */
function ensureMcpDc(tools: string): string {
  const parts = tools.split(',').map(s => s.trim()).filter(Boolean)
  if (parts.some(t => t.startsWith('mcp__dc__'))) {
    return parts.join(', ')
  }
  const filtered = parts.filter(t => t !== 'mcp__dc')
  return [...filtered, ...getDcToolNames().map(t => `mcp__dc__${t}`)].join(', ')
}

/** Save an agent definition. Atomic via temp + rename. */
export function saveAgent(def: AgentDef): void {
  const withDc: AgentDef = { ...def, tools: ensureMcpDc(def.tools ?? '') }
  const validated = AgentDefSchema.parse(withDc)
  mkdirSync(AGENTS_DIR, { recursive: true })
  // Separate the body from the rest of the frontmatter — the body
  // becomes the markdown after the closing `---`; everything else is
  // YAML frontmatter.
  const { body, ...frontmatter } = validated
  const text = serializeAgentMarkdown(frontmatter as Record<string, unknown>, body)
  const finalPath = agentPath(validated.name)
  const tmpPath = `${finalPath}.tmp.${process.pid}`
  writeFileSync(tmpPath, text)
  renameSync(tmpPath, finalPath)
}

/**
 * Delete an agent. Returns true if anything was removed.
 *
 * Removes the agent definition (`<name>.md`) AND the DC-private sidecar
 * directory (`<name>.dc/`, containing contacts/ and chatmail/). The
 * sidecar is owned by contacts.ts but lives here in the agents dir; we
 * clean it up so deleting an agent removes ALL its DC-side state in one
 * shot. CC-owned memory at `~/.claude/agent-memory/<name>/` is NOT
 * deleted — preserved across re-creation.
 *
 * Throws if `name` is the built-in undeletable default agent — that
 * definition is always resurrected by listAgents / ensureDefaultAgent
 * so a delete would be meaningless anyway.
 */
export function deleteAgent(name: string): boolean {
  if (isUndeletableAgent(name)) {
    throw new Error(`cannot delete built-in default agent: ${name}`)
  }
  const file = agentPath(name)
  const sidecar = join(AGENTS_DIR, `${name}.dc`)
  let removed = false
  if (existsSync(file)) {
    unlinkSync(file)
    removed = true
  }
  if (existsSync(sidecar)) {
    rmSync(sidecar, { recursive: true, force: true })
    removed = true
  }
  return removed
}

/** Update just the markdown body (system prompt) on an agent. Returns false if missing. */
export function updateAgentPrompt(name: string, body: string): boolean {
  const agent = getAgent(name)
  if (!agent) return false
  agent.body = body
  saveAgent(agent)
  return true
}

/**
 * Update just the model on an agent. Returns false if missing.
 * Throws on invalid model.
 */
export function updateAgentModel(name: string, model: AllowedModel): boolean {
  if (!ALLOWED_MODELS.includes(model)) {
    throw new Error(`invalid model: ${model}`)
  }
  const agent = getAgent(name)
  if (!agent) return false
  agent.model = model
  saveAgent(agent)
  return true
}

/**
 * Latest model id per tier. Backed by the models manifest
 * (plugin/models.json) so the registry has a single source of truth —
 * adding a new model only requires editing JSON.
 *
 * Used by the NL intent classifier path (e.g., "switch to opus" maps
 * `opus` → the current latest opus model id).
 */
export const LATEST_MODELS: Record<models.ModelTier, string> = Object.fromEntries(
  [...new Set(models.MODELS.map((m) => m.tier))].map((t) => [t, models.latestModelForTier(t)]),
)

/**
 * Update an agent's model to the latest in the named tier. Throws if
 * the agent doesn't exist.
 *
 * Wrapper around updateAgentModel that takes a tier rather than a full
 * model id. Used by the NL intent handler in the dispatcher to act on
 * "switch to <tier>" / "use <tier>" utterances.
 */
export function setAgentModel(agentId: string, tier: models.ModelTier): void {
  const def = getAgent(agentId)
  if (!def) throw new Error(`setAgentModel: no agent ${agentId}`)
  const modelId = LATEST_MODELS[tier]
  if (!modelId) throw new Error(`setAgentModel: unknown tier ${tier}`)
  def.model = modelId
  saveAgent(def)
}

/**
 * Set or clear an agent's reasoning effort level. `null` clears the
 * field so the agent inherits the CLI's persisted default.
 *
 * Throws if the agent doesn't exist.
 */
export function setAgentEffort(agentId: string, level: models.EffortLevel | null): void {
  const def = getAgent(agentId)
  if (!def) throw new Error(`setAgentEffort: no agent ${agentId}`)
  if (level === null) delete def.effort
  else def.effort = level
  saveAgent(def)
}

/**
 * Update an agent's skip-permissions trust flag. Throws if the agent
 * doesn't exist.
 *
 * Wrapper around setSkipPermissions + saveAgent that loads, mutates,
 * and persists in one call. Used by the NL intent handler in the
 * dispatcher to act on "trust me" / "be safer" utterances.
 */
export function setAgentTrust(agentId: string, value: boolean): void {
  const def = getAgent(agentId)
  if (!def) throw new Error(`setAgentTrust: no agent ${agentId}`)
  setSkipPermissions(def, value)
  saveAgent(def)
}

/** The three agent archetypes. Cosmetic — drives the default icon glyph. */
export const ARCHETYPES = ['role', 'utility', 'project'] as const
export type Archetype = typeof ARCHETYPES[number]

/** Metadata key for an agent's archetype (role/utility/project). */
export const ARCHETYPE_META_KEY = 'x-dc-archetype'

/** Metadata key for an agent's icon glyph (single emoji or short string). */
export const ICON_META_KEY = 'x-dc-icon'

/** Default icon glyph for each archetype. Used when no explicit icon is set. */
export const ARCHETYPE_DEFAULT_ICON: Record<Archetype, string> = {
  role: '👤',
  utility: '⚙️',
  project: '📋',
}

/** Read an agent's archetype. Defaults to 'role' when unset or invalid. */
export function getArchetype(def: AgentDef): Archetype {
  const raw = def[ARCHETYPE_META_KEY]
  return (ARCHETYPES as readonly string[]).includes(raw as string)
    ? (raw as Archetype)
    : 'role'
}

/**
 * Write the archetype to an agent in place. Setting the default ('role')
 * clears the key so exports stay minimal. Does not persist — callers
 * must follow with saveAgent.
 */
export function setArchetype(def: AgentDef, value: Archetype): void {
  if (value === 'role') {
    delete def[ARCHETYPE_META_KEY]
    return
  }
  def[ARCHETYPE_META_KEY] = value
}

/** Metadata key for Phase 2 chat-search memory injection. Baked at creation. */
export const MEMORY_BOOST_META_KEY = 'x-dc-memory-boost'

/**
 * Whether Phase 2 auto-injection is enabled. Unset → false, so every
 * pre-existing agent stays off until the creation classifier or the user
 * writes the key.
 */
export function memoryBoostEnabled(def: AgentDef): boolean {
  return def[MEMORY_BOOST_META_KEY] === 'on'
}

/**
 * Write the memory-boost flag in place. Unlike setArchetype, we write 'off'
 * EXPLICITLY rather than deleting on default — the creation classifier records
 * a deliberate decision, and we want to distinguish "classified off" from
 * "never classified" for future migrations. Does not persist — follow with saveAgent.
 */
export function setMemoryBoost(def: AgentDef, value: 'on' | 'off'): void {
  def[MEMORY_BOOST_META_KEY] = value
}

// Whole-word coding signals (word-boundary matched to avoid substring false
// positives like 'api' ∈ "therapist"). Short/ambiguous tokens deliberately
// excluded. A keyword classifier: cheap, deterministic, unit-testable; the
// spec allows swapping a small LLM classify step behind this signature later.
const CODING_SIGNALS = [
  'code', 'coding', 'engineer', 'developer', 'repo', 'repository', 'codebase',
  'compile', 'debug', 'refactor', 'commit', 'deploy', 'bugfix',
  'edit files', 'run tests', 'test suite', 'pull request',
]

/**
 * Decide the Phase 2 default for a NEW agent from its system prompt. Coding
 * agents → 'off' (keep context clean); else → 'on' (conversational agents
 * benefit without configuration). Empty → 'off'. Called only at creation.
 */
export function classifyMemoryBoost(systemPrompt: string): 'on' | 'off' {
  const text = systemPrompt.toLowerCase()
  if (!text.trim()) return 'off'
  const escaped = CODING_SIGNALS.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const rx = new RegExp(`\\b(${escaped.join('|')})\\b`)
  return rx.test(text) ? 'off' : 'on'
}

/**
 * Return the icon glyph for an agent — explicit x-dc-icon if set,
 * otherwise the default glyph for the archetype.
 */
export function iconForAgent(def: AgentDef): string {
  const explicit = def[ICON_META_KEY]
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  return ARCHETYPE_DEFAULT_ICON[getArchetype(def)]
}

/**
 * Return the explicitly-set icon glyph, or null if the agent relies on
 * the archetype default. Used by the edit UI to show the raw override
 * (vs. the rendered fallback).
 */
export function getExplicitIcon(def: AgentDef): string | null {
  const explicit = def[ICON_META_KEY]
  return typeof explicit === 'string' && explicit.length > 0 ? explicit : null
}

/**
 * Write an icon glyph to an agent in place. Passing null or an empty
 * string clears the explicit icon (reverts to archetype default).
 * Does not persist — callers must follow with saveAgent.
 */
export function setIcon(def: AgentDef, value: string | null): void {
  if (!value) {
    delete def[ICON_META_KEY]
    return
  }
  def[ICON_META_KEY] = value
}

/** Metadata key for an agent's Lucide glyph name (e.g. "cog", "calendar"). */
export const GLYPH_META_KEY = 'x-dc-glyph'

/**
 * Read the explicit Lucide glyph name set on an agent. Returns null if
 * unset. The caller decides whether to validate against the archetype's
 * palette — see glyphForAgent for the validated lookup.
 */
export function getGlyph(def: AgentDef): string | null {
  const v = def[GLYPH_META_KEY]
  return typeof v === 'string' && v.length > 0 ? v : null
}

/**
 * Write a Lucide glyph name to an agent in place. Passing null or
 * an empty string clears the override (renderer falls back to archetype
 * default). Does not persist — caller must follow with saveAgent.
 */
export function setGlyph(def: AgentDef, value: string | null): void {
  if (!value) {
    delete def[GLYPH_META_KEY]
    return
  }
  def[GLYPH_META_KEY] = value
}

/**
 * Return the resolved Lucide glyph name for an agent: the explicit
 * x-dc-glyph if set AND in the archetype's curated palette, otherwise
 * the archetype default. A glyph from a different archetype's palette
 * is treated as unset (falls back to default).
 */
export function glyphForAgent(def: AgentDef): string {
  const archetype = getArchetype(def)
  const explicit = getGlyph(def)
  if (explicit) {
    const palette = ARCHETYPE_PALETTES[archetype] as readonly string[]
    if (palette.includes(explicit)) return explicit
  }
  return ARCHETYPE_DEFAULT_GLYPH[archetype]
}

/** Metadata key for an agent's background pattern (one of PATTERN_IDS). */
export const PATTERN_META_KEY = 'x-dc-pattern'

/**
 * Read the resolved background pattern for an agent. Falls back to
 * 'checker' if the metadata is unset, an unknown pattern id, or the
 * wrong type. Pattern only affects the trust-on (skip-permissions)
 * badge variant; trust-off badges always render as a single solid
 * color regardless.
 */
export function patternForAgent(def: AgentDef): PatternId {
  const v = def[PATTERN_META_KEY]
  if (typeof v === 'string' && (PATTERN_IDS as readonly string[]).includes(v)) {
    return v as PatternId
  }
  return 'checker'
}

/**
 * Write a background pattern into an agent in place. Does not persist
 * — callers must call saveAgent(def) afterwards. Used by
 * setSkipPermissions to roll a fresh random pattern when trust
 * transitions from off to on, so visually-similar same-tier agents
 * diverge each time they're trusted.
 */
export function setPattern(def: AgentDef, pattern: PatternId): void {
  def[PATTERN_META_KEY] = pattern
}

/**
 * Read the skipPermissions flag from an agent definition. v1.4: this
 * is `permissionMode === 'bypassPermissions'` (top-level CC field).
 * Defaults to false when permissionMode is unset.
 */
export function getSkipPermissions(def: AgentDef): boolean {
  return def.permissionMode === 'bypassPermissions'
}

/**
 * Set the skip-permissions trust state on an agent in place by writing
 * the top-level `permissionMode` field. Setting false deletes the key
 * so exported frontmatter stays minimal. Does not persist — callers
 * must follow with saveAgent.
 *
 * Side effect: when trust transitions from off → on, also rolls a fresh
 * random background pattern. Pattern is only visually meaningful while
 * trust is on, and re-rolling each enable gives visually-distinct
 * badges to repeat trust toggles. Idempotent re-saves (already-true
 * staying true) do NOT roll a new pattern.
 */
export function setSkipPermissions(def: AgentDef, value: boolean): void {
  const prev = getSkipPermissions(def)
  if (value) {
    def.permissionMode = 'bypassPermissions'
    if (!prev) setPattern(def, randomPatternId())
    return
  }
  delete def.permissionMode
}

/** Frontmatter key for the icon mirror flag (true = facing-right variant). */
export const ICON_MIRROR_META_KEY = 'x-dc-icon-mirror'

/**
 * Read the icon mirror flag from an agent definition. Defaults to false
 * (original orientation, facing left). When true, the chat profile image
 * uses the horizontally-flipped variant so the agent's spy faces right.
 */
export function getIconMirror(def: AgentDef): boolean {
  return def[ICON_MIRROR_META_KEY] === true
}

/**
 * Write the icon mirror flag to an agent in place. Setting false
 * removes the key entirely so exported frontmatter stays minimal. Does
 * not persist — callers must call saveAgent(def) afterwards.
 */
export function setIconMirror(def: AgentDef, value: boolean): void {
  if (value) {
    def[ICON_MIRROR_META_KEY] = true
    return
  }
  delete def[ICON_MIRROR_META_KEY]
}

/** Pure name → slug conversion — no collision check. */
export function slugifyName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'agent'
  )
}

/**
 * Synthesize a slug-based agent name from a free-form display name,
 * resolving collisions by suffixing -2, -3, etc.
 */
export function synthesizeAgentName(displayName: string): string {
  const base = slugifyName(displayName)
  if (!existsSync(AGENTS_DIR)) return base
  const existing = new Set<string>()
  for (const entry of readdirSync(AGENTS_DIR)) {
    if (!entry.endsWith('.md')) continue
    existing.add(entry.slice(0, -'.md'.length))
  }
  if (!existing.has(base)) return base
  let n = 2
  while (existing.has(`${base}-${n}`)) n++
  return `${base}-${n}`
}

/** @deprecated Renamed to `synthesizeAgentName` in v1.4. */
export const synthesizeAgentId = synthesizeAgentName

/**
 * Result of importing an agent from a markdown file.
 */
export interface ImportResult {
  agent: AgentDef
  /** True if the imported agent's name was suffixed to resolve a collision. */
  nameChanged: boolean
}

/**
 * Parse a markdown file (CC frontmatter + body) as an agent definition,
 * resolve name collisions, and persist. Throws on parse/validation
 * failure.
 *
 * If frontmatter has no `name` field, one is synthesized from
 * `x-dc-display-name` (if set) or `description` (fallback). Collisions
 * append `-2`, `-3`, etc. and set `nameChanged: true`.
 */
export function importAgentFromMarkdown(text: string): ImportResult {
  const { frontmatter, body } = parseAgentMarkdown(text)
  const hasExplicitName =
    typeof frontmatter.name === 'string' && (frontmatter.name as string).length > 0

  if (!hasExplicitName) {
    const fallbackSource =
      (typeof frontmatter['x-dc-display-name'] === 'string'
        ? (frontmatter['x-dc-display-name'] as string)
        : '') ||
      (typeof frontmatter.description === 'string'
        ? (frontmatter.description as string)
        : '') ||
      'agent'
    frontmatter.name = synthesizeAgentName(fallbackSource)
  }

  const combined = { ...frontmatter, body }
  const validated = AgentDefSchema.parse(combined)

  let finalName = validated.name
  let nameChanged = false
  if (hasExplicitName && getAgent(finalName)) {
    const base = finalName
    let n = 2
    while (getAgent(`${base}-${n}`)) n++
    finalName = `${base}-${n}`
    nameChanged = true
  } else if (!hasExplicitName) {
    // synthesizeAgentName already resolved collisions — detect suffix.
    const fallback =
      (typeof frontmatter['x-dc-display-name'] === 'string'
        ? (frontmatter['x-dc-display-name'] as string)
        : '') ||
      (typeof frontmatter.description === 'string'
        ? (frontmatter.description as string)
        : '') ||
      'agent'
    if (finalName !== slugifyName(fallback)) nameChanged = true
  }

  const agent: AgentDef = { ...validated, name: finalName }
  saveAgent(agent)
  return { agent, nameChanged }
}

/**
 * Build a draft agent from a free-form description. Defaults to Sonnet;
 * callers (dc_create_agent) can override the model via an optional
 * `model` parameter — the calling LLM has full conversation context
 * and picks the best tier.
 */
export function draftAgentFromDescription(
  description: string,
  model?: AllowedModel,
): {
  agent: DraftAgent
  inheritClaudeMd: boolean
} {
  const effectiveModel = model ?? DEFAULT_MODEL
  const tier = models.tierForModel(effectiveModel)
  const system = models.systemPromptForTier(tier) ?? DEFAULT_SYSTEM_PROMPT

  // Extract purpose-only name by removing preamble like "I want a", "create a".
  let name = description.trim()
  name = name.replace(
    /^(i\s+want\s+[an\s]+|create\s+[an\s]+|i\s+need\s+[an\s]+|set\s+up\s+[an\s]+|make\s+[an\s]+)/i,
    '',
  )
  name =
    name
      .split(/\s+/)
      .slice(0, 4)
      .join(' ')
      .replace(/[^\w\s-]/g, '')
      .trim() || 'New Agent'
  name = name
    .split(/\s+/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
  if (!/\b(agent|assistant)$/i.test(name)) {
    name += ' Agent'
  }

  return {
    agent: {
      description: name,
      model: effectiveModel,
      tools: 'mcp__dc',
      body: system,
      memory: 'user',
      'x-dc-display-name': name,
    },
    inheritClaudeMd: inheritClaudeMdForModel(effectiveModel),
  }
}
