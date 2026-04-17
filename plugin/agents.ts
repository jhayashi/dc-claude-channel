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
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import YAML from 'yaml'
import { z } from 'zod'
import * as bindings from './bindings.js'
import * as models from './models.js'

let AGENTS_DIR = join(homedir(), '.claude', 'channels', 'deltachat', 'agents')

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
 * Sentinel id for the built-in default agent. This agent is always
 * present (auto-seeded by listAgents / ensureDefaultAgent) and cannot
 * be deleted (deleteAgent throws on this id). Its name / model /
 * prompt / metadata are still editable — only the id and its existence
 * are immutable.
 */
export const DEFAULT_AGENT_ID = 'claude-code'

/** Whether an agent id is the undeletable built-in default. */
export function isUndeletableAgent(id: string): boolean {
  return id === DEFAULT_AGENT_ID
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
    id: DEFAULT_AGENT_ID,
    name: 'Claude Code',
    model: DEFAULT_MODEL,
    description: '',
    system: DEFAULT_SYSTEM_PROMPT,
    tools: [],
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
 * Agent definition schema. Matches the Claude Managed Agents API format
 * (name, model, description, system, tools, skills, mcp_servers,
 * metadata). Optional fields are accepted on import but not yet
 * exposed in the UI.
 */
export const AgentDefSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'id must be a lowercase slug'),
  name: z.string().min(1).max(256),
  model: z.string().refine(
    (v): v is string => models.isKnownModel(v),
    v => ({ message: `Unknown model "${v}". Allowed: ${ALLOWED_MODELS.join(', ')}` }),
  ),
  description: z.string().max(2048).default(''),
  system: z.string().max(100_000).default(''),
  tools: z.array(z.object({ type: z.string() })).default([]),
  skills: z.array(z.unknown()).optional(),
  mcp_servers: z.array(z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  /**
   * Allowlist of built-in tool names (Bash, Read, Write, etc.) this agent
   * may use. null or absent = all tools allowed. [] = no tools allowed.
   */
  allowedBuiltinTools: z.array(z.string()).nullable().optional(),
  /**
   * Allowlist of MCP server prefixes (dc, claude_ai_Gmail, etc.) this agent
   * may use. null or absent = all servers allowed. [] = no MCP servers.
   */
  allowedMcpServers: z.array(z.string()).nullable().optional(),
  /** @deprecated Use allowedMcpServers. Kept for migration compat. */
  allowedMcpTools: z.array(z.string()).nullable().optional(),
})

export type AgentDef = z.infer<typeof AgentDefSchema>

/**
 * Draft agent — same shape as AgentDef but without an id. Used in the
 * WebXDC setup flow where the user edits a draft before committing, at
 * which point the id is synthesized from the final name.
 */
export const DraftAgentSchema = AgentDefSchema.omit({ id: true })
export type DraftAgent = z.infer<typeof DraftAgentSchema>

function agentPath(id: string): string {
  return join(AGENTS_DIR, `${id}.yaml`)
}

/**
 * List all agent definitions on disk, sorted by id. Invalid files skipped.
 * Auto-seeds the built-in default agent (DEFAULT_AGENT_ID) if it's missing,
 * so the agent list is never empty.
 */
export function listAgents(): AgentDef[] {
  mkdirSync(AGENTS_DIR, { recursive: true })
  ensureDefaultAgent()
  const out: AgentDef[] = []
  for (const entry of readdirSync(AGENTS_DIR)) {
    if (!entry.endsWith('.yaml')) continue
    const id = entry.slice(0, -'.yaml'.length)
    const agent = getAgent(id)
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

/** Get a single agent by id. Returns null if missing or invalid. */
export function getAgent(id: string): AgentDef | null {
  const path = agentPath(id)
  if (!existsSync(path)) return null
  let raw: unknown
  try {
    raw = YAML.parse(readFileSync(path, 'utf-8'))
  } catch {
    return null
  }
  const parsed = AgentDefSchema.safeParse(raw)
  return parsed.success ? migrateToolsToServers(parsed.data) : null
}

/** Save an agent definition. Atomic via temp + rename. */
export function saveAgent(def: AgentDef): void {
  const validated = AgentDefSchema.parse(def)
  mkdirSync(AGENTS_DIR, { recursive: true })
  const finalPath = agentPath(validated.id)
  const tmpPath = `${finalPath}.tmp.${process.pid}`
  writeFileSync(tmpPath, YAML.stringify(validated))
  renameSync(tmpPath, finalPath)
}

/**
 * Delete an agent. Returns true if a file was removed.
 * Throws if `id` is the built-in undeletable default agent — that
 * definition is always resurrected by listAgents / ensureDefaultAgent
 * so a delete would be meaningless anyway.
 */
export function deleteAgent(id: string): boolean {
  if (isUndeletableAgent(id)) {
    throw new Error(`cannot delete built-in default agent: ${id}`)
  }
  const path = agentPath(id)
  if (!existsSync(path)) return false
  unlinkSync(path)
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
 */
export function setSkipPermissions(def: AgentDef, value: boolean): void {
  if (value) {
    if (!def.metadata) def.metadata = {}
    def.metadata[SKIP_PERMISSIONS_META_KEY] = true
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
  const existing = new Set(
    readdirSync(AGENTS_DIR)
      .filter(e => e.endsWith('.yaml'))
      .map(e => e.slice(0, -'.yaml'.length)),
  )
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
