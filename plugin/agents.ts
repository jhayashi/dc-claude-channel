/**
 * Agent definition registry — portable agent definitions stored as YAML
 * files that match the Claude Managed Agents schema, with x-dc-*
 * extensions for fields specific to this plugin.
 *
 * State stored in ~/.claude/channels/deltachat/agents/<agentId>.yaml.
 * Each agent has a slug-based id (filename) used as its reference key
 * from bindings. Agents are reusable — multiple chat bindings may point
 * to the same agent definition (Option D of the 2026-04-09 spec).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import YAML from 'yaml'
import { z } from 'zod'
import { parseAgentMarkdown, serializeAgentMarkdown } from './agent-md.js'
import * as bindings from './bindings.js'
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
export const AgentDefSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'name must be a lowercase slug').max(64),
  description: z.string().max(2048).default(''),
  model: z.string().refine(
    (v): v is string => models.isKnownModel(v),
    v => ({ message: `Unknown model "${v}". Allowed: ${ALLOWED_MODELS.join(', ')}` }),
  ),
  tools: z.string().default(''),
  disallowedTools: z.string().optional(),
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
  // Markdown body — the agent's system prompt.
  body: z.string().max(100_000).default(''),
})

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
 * Migrate legacy `agents/<id>.yaml` files to `agents/<id>/definition.yaml`.
 * Runs at dispatcher startup. Idempotent: skips ids whose directory shape
 * already exists. Safe across partial failure — never destructive, the
 * legacy file is `renameSync`d into the new location.
 *
 * Returns the number of agents migrated.
 */
export function migrateLegacyAgentYaml(): number {
  if (!existsSync(AGENTS_DIR)) return 0
  let migrated = 0
  let entries: string[]
  try {
    entries = readdirSync(AGENTS_DIR)
  } catch {
    return 0
  }
  for (const entry of entries) {
    if (!entry.endsWith('.yaml')) continue
    const id = entry.slice(0, -'.yaml'.length)
    const oldPath = join(AGENTS_DIR, entry)
    const newDir = agentDir(id)
    const newPath = agentPath(id)
    if (existsSync(newPath)) {
      // Directory shape already exists; leave the legacy file alone for
      // operator inspection. Don't delete — that would be destructive on
      // an unexpected state.
      console.error(`agents: legacy ${entry} coexists with ${id}/definition.yaml; leaving in place`)
      continue
    }
    try {
      mkdirSync(newDir, { recursive: true })
      renameSync(oldPath, newPath)
      migrated++
    } catch (err) {
      console.error(`agents: migrate ${entry} → ${id}/definition.yaml failed:`, err)
    }
  }
  return migrated
}

/**
 * List all agent definitions on disk, sorted by id. Invalid records skipped.
 * Auto-seeds the built-in default agent (DEFAULT_AGENT_ID) if it's missing,
 * so the agent list is never empty.
 */
export function listAgents(): AgentDef[] {
  mkdirSync(AGENTS_DIR, { recursive: true })
  ensureDefaultAgent()
  const out: AgentDef[] = []
  for (const entry of readdirSync(AGENTS_DIR)) {
    // v1.3 slice 7 phase 1: agents are subdirectories now. Defensive
    // skips for any leftover files (legacy YAMLs that didn't migrate).
    const dirPath = join(AGENTS_DIR, entry)
    let isDir = false
    try { isDir = statSync(dirPath).isDirectory() } catch { /* ignore */ }
    if (!isDir) continue
    const agent = getAgent(entry)
    if (agent) out.push(agent)
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * Migrate legacy allowedMcpTools (per-tool names) to allowedMcpServers
 * (per-server prefixes). All DC tools map to the 'dc' server prefix.
 */
export function migrateToolsToServers(agent: AgentDef): AgentDef {
  if (agent.allowedMcpTools != null && agent.allowedMcpServers === undefined) {
    agent.allowedMcpServers = agent.allowedMcpTools.length > 0 ? ['dc'] : []
    agent.allowedMcpTools = undefined
  }
  return agent
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

/** Save an agent definition. Atomic via temp + rename. */
export function saveAgent(def: AgentDef): void {
  const validated = AgentDefSchema.parse(def)
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
 * Removes the entire `agents/<id>/` directory — that's where v1.4's
 * per-agent contacts/, memory/, and chatmail/ subdirs will live, so
 * deleting an agent removes ALL its associated state in one shot. v1.3
 * has only `definition.yaml` underneath today; the recursive remove is
 * still the right semantic.
 *
 * Throws if `id` is the built-in undeletable default agent — that
 * definition is always resurrected by listAgents / ensureDefaultAgent
 * so a delete would be meaningless anyway.
 */
export function deleteAgent(id: string): boolean {
  if (isUndeletableAgent(id)) {
    throw new Error(`cannot delete built-in default agent: ${id}`)
  }
  const dir = agentDir(id)
  if (!existsSync(dir)) return false
  rmSync(dir, { recursive: true, force: true })
  return true
}

/** Update just the system prompt on an agent. Returns false if missing. */
export function updateAgentPrompt(id: string, system: string): boolean {
  const agent = getAgent(id)
  if (!agent) return false
  agent.system = system
  saveAgent(agent)
  return true
}

/**
 * Update just the model on an agent. Returns false if missing.
 * Throws on invalid model.
 */
export function updateAgentModel(id: string, model: AllowedModel): boolean {
  if (!ALLOWED_MODELS.includes(model)) {
    throw new Error(`invalid model: ${model}`)
  }
  const agent = getAgent(id)
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
export const LATEST_MODELS: Record<models.ModelTier, string> = {
  haiku: models.latestModelForTier('haiku'),
  sonnet: models.latestModelForTier('sonnet'),
  opus: models.latestModelForTier('opus'),
}

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
  def.model = LATEST_MODELS[tier]
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
  const raw = def.metadata?.[ARCHETYPE_META_KEY]
  return (ARCHETYPES as readonly string[]).includes(raw as string)
    ? (raw as Archetype)
    : 'role'
}

/**
 * Write the archetype to an agent's metadata bag in place. Setting the
 * default ('role') clears the key so exports stay minimal. Does not
 * persist — callers must follow with saveAgent.
 */
export function setArchetype(def: AgentDef, value: Archetype): void {
  if (value === 'role') {
    if (def.metadata) delete def.metadata[ARCHETYPE_META_KEY]
    return
  }
  if (!def.metadata) def.metadata = {}
  def.metadata[ARCHETYPE_META_KEY] = value
}

/**
 * Return the icon glyph for an agent — explicit x-dc-icon if set,
 * otherwise the default glyph for the archetype.
 */
export function iconForAgent(def: AgentDef): string {
  const explicit = def.metadata?.[ICON_META_KEY]
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  return ARCHETYPE_DEFAULT_ICON[getArchetype(def)]
}

/**
 * Return the explicitly-set icon glyph, or null if the agent relies on
 * the archetype default. Used by the edit UI to show the raw override
 * (vs. the rendered fallback).
 */
export function getExplicitIcon(def: AgentDef): string | null {
  const explicit = def.metadata?.[ICON_META_KEY]
  return typeof explicit === 'string' && explicit.length > 0 ? explicit : null
}

/**
 * Write an icon glyph to an agent's metadata bag. Passing null or an
 * empty string clears the explicit icon (reverts to archetype default).
 * Does not persist — callers must follow with saveAgent.
 */
export function setIcon(def: AgentDef, value: string | null): void {
  if (!value) {
    if (def.metadata) delete def.metadata[ICON_META_KEY]
    return
  }
  if (!def.metadata) def.metadata = {}
  def.metadata[ICON_META_KEY] = value
}

/** Metadata key for an agent's Lucide glyph name (e.g. "cog", "calendar"). */
export const GLYPH_META_KEY = 'x-dc-glyph'

/**
 * Read the explicit Lucide glyph name set on an agent. Returns null if
 * unset. The caller decides whether to validate against the archetype's
 * palette — see glyphForAgent for the validated lookup.
 */
export function getGlyph(def: AgentDef): string | null {
  const v = def.metadata?.[GLYPH_META_KEY]
  return typeof v === 'string' && v.length > 0 ? v : null
}

/**
 * Write a Lucide glyph name to an agent's metadata bag. Passing null or
 * an empty string clears the override (renderer falls back to archetype
 * default). Does not persist — caller must follow with saveAgent.
 */
export function setGlyph(def: AgentDef, value: string | null): void {
  if (!value) {
    if (def.metadata) delete def.metadata[GLYPH_META_KEY]
    return
  }
  if (!def.metadata) def.metadata = {}
  def.metadata[GLYPH_META_KEY] = value
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
  const v = def.metadata?.[PATTERN_META_KEY]
  if (typeof v === 'string' && (PATTERN_IDS as readonly string[]).includes(v)) {
    return v as PatternId
  }
  return 'checker'
}

/**
 * Write a background pattern into an agent's metadata bag in place.
 * Does not persist — callers must call saveAgent(def) afterwards.
 * Used by setSkipPermissions to roll a fresh random pattern when trust
 * transitions from off to on, so visually-similar same-tier agents
 * diverge each time they're trusted.
 */
export function setPattern(def: AgentDef, pattern: PatternId): void {
  if (!def.metadata) def.metadata = {}
  def.metadata[PATTERN_META_KEY] = pattern
}

/** Metadata key used to store the skipPermissions flag inside an agent's metadata bag. */
export const SKIP_PERMISSIONS_META_KEY = 'x-dc-skipPermissions'

/**
 * Read the skipPermissions flag from an agent definition. Defaults to
 * false when the metadata bag or key is absent. An agent with this
 * flag set has its subagent tool calls auto-approved by the dispatcher;
 * see plugin/dispatcher/permission-handler.ts for the short-circuit path.
 */
export function getSkipPermissions(def: AgentDef): boolean {
  const meta = def.metadata
  if (!meta) return false
  return meta[SKIP_PERMISSIONS_META_KEY] === true
}

/**
 * Write the skipPermissions flag into an agent's metadata bag in place.
 * Setting false removes the key entirely so exported YAML stays minimal;
 * other metadata entries are preserved. Does not persist — callers must
 * call saveAgent(def) afterwards.
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
    if (!def.metadata) def.metadata = {}
    def.metadata[SKIP_PERMISSIONS_META_KEY] = true
    if (!prev) setPattern(def, randomPatternId())
    return
  }
  if (!def.metadata) return
  delete def.metadata[SKIP_PERMISSIONS_META_KEY]
}

/** Metadata key for the icon mirror flag (true = facing-right variant). */
export const ICON_MIRROR_META_KEY = 'x-dc-iconMirror'

/**
 * Read the icon mirror flag from an agent definition. Defaults to false
 * (original orientation, facing left). When true, the chat profile image
 * uses the horizontally-flipped variant so the agent's spy faces right.
 */
export function getIconMirror(def: AgentDef): boolean {
  const meta = def.metadata
  if (!meta) return false
  return meta[ICON_MIRROR_META_KEY] === true
}

/**
 * Write the icon mirror flag into an agent's metadata bag in place.
 * Setting false removes the key entirely so exported YAML stays minimal.
 * Does not persist — callers must call saveAgent(def) afterwards.
 */
export function setIconMirror(def: AgentDef, value: boolean): void {
  if (value) {
    if (!def.metadata) def.metadata = {}
    def.metadata[ICON_MIRROR_META_KEY] = true
    return
  }
  if (!def.metadata) return
  delete def.metadata[ICON_MIRROR_META_KEY]
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
 * Synthesize a slug-based agent id from a name, resolving collisions by
 * suffixing -2, -3, etc. The result always matches AgentDefSchema.id.
 */
export function synthesizeAgentId(name: string): string {
  const base = slugifyName(name)
  if (!existsSync(AGENTS_DIR)) return base
  // v1.3 slice 7 phase 1: agents are subdirectories now (each with
  // its own definition.yaml). Collision check reads the directory
  // listing — every entry that's a subdir AND has a definition.yaml
  // is an existing agent id.
  const existing = new Set<string>()
  for (const entry of readdirSync(AGENTS_DIR)) {
    const dirPath = join(AGENTS_DIR, entry)
    try {
      if (!statSync(dirPath).isDirectory()) continue
      if (existsSync(join(dirPath, 'definition.yaml'))) existing.add(entry)
    } catch { /* ignore */ }
  }
  if (!existing.has(base)) return base
  let n = 2
  while (existing.has(`${base}-${n}`)) n++
  return `${base}-${n}`
}

/**
 * Result of importing an agent from YAML.
 */
export interface ImportResult {
  agent: AgentDef
  idChanged: boolean
}

/**
 * Parse a YAML string as an agent definition, resolve ID collisions,
 * and persist. Throws on parse/validation failure.
 *
 * If the YAML has no `id` field, one is synthesized from `name`.
 * If the id (provided or synthesized) collides with an existing agent,
 * a `-2`, `-3`, etc. suffix is appended and `idChanged` is set.
 */
export function importAgentFromYaml(yamlStr: string): ImportResult {
  const raw = YAML.parse(yamlStr)
  if (!raw || typeof raw !== 'object') {
    throw new Error('YAML did not produce an object')
  }

  const hasExplicitId = typeof raw.id === 'string' && raw.id.length > 0

  if (!hasExplicitId) {
    // Validate without id to catch missing name early, then synthesize.
    AgentDefSchema.omit({ id: true }).parse(raw)
    raw.id = synthesizeAgentId(raw.name)
  }

  // Validate the full schema now that id is present.
  const validated = AgentDefSchema.parse(raw)

  let finalId = validated.id
  let idChanged = false

  if (hasExplicitId && getAgent(finalId)) {
    // Explicit id collides — suffix it directly.
    const base = finalId
    let n = 2
    while (getAgent(`${base}-${n}`)) n++
    finalId = `${base}-${n}`
    idChanged = true
  } else if (!hasExplicitId) {
    // synthesizeAgentId already resolved collisions — detect whether
    // it suffixed by comparing with the bare slug.
    const bareSlug = slugifyName(validated.name)
    if (finalId !== bareSlug) idChanged = true
  }

  const agent: AgentDef = { ...validated, id: finalId }
  saveAgent(agent)
  return { agent, idChanged }
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
      name,
      model: effectiveModel,
      system,
      tools: [],
    },
    inheritClaudeMd: inheritClaudeMdForModel(effectiveModel),
  }
}
