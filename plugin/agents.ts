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

let AGENTS_DIR = join(homedir(), '.claude', 'channels', 'deltachat', 'agents')

/** Override the storage directory (for tests). */
export function setAgentsDir(dir: string): void {
  AGENTS_DIR = dir
}

/** Allowed model ids for agent definitions. */
export const ALLOWED_MODELS = [
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
] as const
export type AllowedModel = typeof ALLOWED_MODELS[number]

/** Default system prompt for newly created agents. */
export const DEFAULT_SYSTEM_PROMPT =
  'You are a helpful assistant in this chat. Match the tone of the conversation.'

/** Default model for newly created agents. */
export const DEFAULT_MODEL: AllowedModel = 'claude-sonnet-4-6'

/**
 * Whether an agent should inherit the dispatcher's CLAUDE.md.
 * Haiku agents skip it (minimal context); others get full project context.
 */
export function inheritClaudeMdForModel(model: AllowedModel): boolean {
  return model !== 'claude-haiku-4-5'
}

/**
 * Agent definition schema. Matches the Claude Managed Agents API format
 * (name, model, description, system, tools, skills, mcp_servers,
 * metadata). Optional fields are accepted on import but not yet
 * exposed in the UI.
 */
export const AgentDefSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'id must be a lowercase slug'),
  name: z.string().min(1).max(256),
  model: z.enum(ALLOWED_MODELS),
  description: z.string().max(2048).default(''),
  system: z.string().max(100_000).default(''),
  tools: z.array(z.object({ type: z.string() })).default([]),
  skills: z.array(z.unknown()).optional(),
  mcp_servers: z.array(z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
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

/** List all agent definitions on disk, sorted by id. Invalid files skipped. */
export function listAgents(): AgentDef[] {
  if (!existsSync(AGENTS_DIR)) return []
  const out: AgentDef[] = []
  for (const entry of readdirSync(AGENTS_DIR)) {
    if (!entry.endsWith('.yaml')) continue
    const id = entry.slice(0, -'.yaml'.length)
    const agent = getAgent(id)
    if (agent) out.push(agent)
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
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
  return parsed.success ? parsed.data : null
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

/** Check whether an agent has zero bindings (not used by any chat). */
export function isOrphaned(agentId: string): boolean {
  return bindings.countByAgentId(agentId) === 0
}

/** Delete an agent. Returns true if a file was removed. */
export function deleteAgent(id: string): boolean {
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

/**
 * Synthesize a slug-based agent id from a name, resolving collisions by
 * suffixing -2, -3, etc. The result always matches AgentDefSchema.id.
 */
export function synthesizeAgentId(name: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'agent'
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

/** System prompt templates per model tier. */
const SYSTEM_PROMPTS: Record<string, string> = {
  'claude-opus-4-6':
    'You are helping with software engineering work in this chat. ' +
    'Read code carefully, prefer surgical edits, and explain non-obvious decisions.',
  'claude-haiku-4-5':
    'You are answering quick questions in this chat. Be concise and direct. ' +
    'Skip preamble; one or two sentences is usually enough.',
}

/**
 * Build a draft agent from a free-form description. Defaults to Sonnet;
 * callers (dc_propose_agent, dc_create_agent) can override the model
 * via an optional `model` parameter — the calling LLM has full
 * conversation context and picks the best tier.
 */
export function draftAgentFromDescription(
  description: string,
  model?: AllowedModel,
): {
  agent: DraftAgent
  inheritClaudeMd: boolean
} {
  const effectiveModel = model ?? DEFAULT_MODEL
  const system = SYSTEM_PROMPTS[effectiveModel] ?? DEFAULT_SYSTEM_PROMPT

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
