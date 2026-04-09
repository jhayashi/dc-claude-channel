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

/**
 * Archetypes that seed a new agent from a description. Drives icon
 * selection, default model, default prompt, and the default
 * inheritClaudeMd flag (which lives on the binding, not the agent).
 */
export const AGENT_TYPES = {
  coding: {
    label: 'Coding',
    description: 'Long-form coding work. Opus, full project context.',
    model: 'claude-opus-4-6' as const,
    inheritClaudeMd: true,
    defaultPrompt:
      'You are helping with software engineering work in this chat. ' +
      'Read code carefully, prefer surgical edits, and explain non-obvious decisions.',
  },
  quick: {
    label: 'Quick',
    description: 'Fast Q&A and short tasks. Haiku, minimal context.',
    model: 'claude-haiku-4-5' as const,
    inheritClaudeMd: false,
    defaultPrompt:
      'You are answering quick questions in this chat. Be concise and direct. ' +
      'Skip preamble; one or two sentences is usually enough.',
  },
  basic: {
    label: 'Basic',
    description: 'General-purpose assistant. Sonnet.',
    model: 'claude-sonnet-4-6' as const,
    inheritClaudeMd: true,
    defaultPrompt:
      'You are a helpful assistant in this chat. Match the tone of the conversation.',
  },
} as const

export type AgentType = keyof typeof AGENT_TYPES

/**
 * Agent definition schema. Matches the Claude Managed Agents format
 * (name, model, system, tools) plus x-dc-* extensions for fields unique
 * to this plugin. The x-dc-* namespace prevents collision with future
 * upstream fields.
 */
export const AgentDefSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'id must be a lowercase slug'),
  name: z.string().min(1).max(80),
  model: z.enum(ALLOWED_MODELS),
  system: z.string(),
  tools: z.array(z.object({ type: z.string() })).default([]),
  'x-dc-type': z.enum(['coding', 'quick', 'basic']),
  'x-dc-description': z.string().default(''),
  'x-dc-createdAt': z.string(),
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

/**
 * Build a draft agent from a free-form description by keyword-guessing
 * the type and using that type's default prompt. Pure function (except
 * for Date.now for the createdAt timestamp). Returns the draft agent
 * (without id — synthesized on save) plus the default inheritClaudeMd
 * for the binding.
 */
export function draftAgentFromDescription(description: string): {
  agent: DraftAgent
  inheritClaudeMd: boolean
} {
  const d = description.toLowerCase()
  let type: AgentType = 'basic'
  if (
    /\b(cod(e|ing)|repo|bug|debug|refactor|implement|pr|pull request|test|build|compile|typescript|python|rust|go\b)/.test(
      d,
    )
  ) {
    type = 'coding'
  } else if (/\b(quick|fast|short|simple|brief|q\s*&\s*a|qa|ask)/.test(d)) {
    type = 'quick'
  }
  const t = AGENT_TYPES[type]

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
      .trim() || `${t.label} Agent`
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
      model: t.model,
      system: t.defaultPrompt,
      tools: [],
      'x-dc-type': type,
      'x-dc-description': description,
      'x-dc-createdAt': new Date().toISOString(),
    },
    inheritClaudeMd: t.inheritClaudeMd,
  }
}
