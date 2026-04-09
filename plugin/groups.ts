/**
 * Group context store — maps Delta Chat group chat IDs to behavior config.
 *
 * Each group has a typed config (coding / quick / basic) plus a system prompt
 * that augments Claude's behavior in that group, and a model selection.
 *
 * State stored in ~/.claude/channels/deltachat/groups/<chatId>.json.
 *
 * Backwards compatibility: old files containing only {name, prompt} are
 * migrated on read to a full GroupContext with sensible defaults.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

let GROUPS_DIR = join(homedir(), '.claude', 'channels', 'deltachat', 'groups')

/** Override the storage directory (for tests). */
export function setGroupsDir(dir: string): void {
  GROUPS_DIR = dir
}

export const GROUP_TYPES = {
  coding: {
    label: 'Coding',
    description: 'Long-form coding work. Opus, full project context.',
    model: 'claude-opus-4-6' as const,
    inheritClaudeMd: true,
    defaultPrompt:
      'You are helping with software engineering work in this group. ' +
      'Read code carefully, prefer surgical edits, and explain non-obvious decisions.',
  },
  quick: {
    label: 'Quick',
    description: 'Fast Q&A and short tasks. Haiku, minimal context.',
    model: 'claude-haiku-4-5' as const,
    inheritClaudeMd: false,
    defaultPrompt:
      'You are answering quick questions in this group. Be concise and direct. ' +
      'Skip preamble; one or two sentences is usually enough.',
  },
  basic: {
    label: 'Basic',
    description: 'General-purpose assistant. Sonnet.',
    model: 'claude-sonnet-4-6' as const,
    inheritClaudeMd: true,
    defaultPrompt:
      'You are a helpful assistant in this group. Match the tone of the conversation.',
  },
} as const

export type GroupType = keyof typeof GROUP_TYPES

export const GroupConfigSchema = z.object({
  type: z.enum(['coding', 'quick', 'basic']),
  name: z.string().min(1),
  description: z.string(),
  systemPrompt: z.string(),
  model: z.enum(['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5']),
  inheritClaudeMd: z.boolean(),
  createdAt: z.string(),
})

export type GroupContext = z.infer<typeof GroupConfigSchema>

/** Get the context for a group, or null if not a managed group. */
export function getGroupContext(chatId: number): GroupContext | null {
  const path = join(GROUPS_DIR, `${chatId}.json`)
  if (!existsSync(path)) return null
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return null
  }
  const parsed = GroupConfigSchema.safeParse(raw)
  if (parsed.success) return parsed.data
  // Legacy migration: {name, prompt}
  if (raw && typeof raw === 'object' && 'name' in raw && 'prompt' in raw) {
    const legacy = raw as { name: string; prompt: string }
    const t = GROUP_TYPES.basic
    return {
      type: 'basic',
      name: legacy.name,
      description: '',
      systemPrompt: legacy.prompt,
      model: t.model,
      inheritClaudeMd: t.inheritClaudeMd,
      createdAt: new Date(0).toISOString(),
    }
  }
  return null
}

/** Save context for a group. Atomic via temp + rename. */
export function setGroupContext(chatId: number, ctx: GroupContext): void {
  const validated = GroupConfigSchema.parse(ctx)
  mkdirSync(GROUPS_DIR, { recursive: true })
  const finalPath = join(GROUPS_DIR, `${chatId}.json`)
  const tmpPath = `${finalPath}.tmp.${process.pid}`
  writeFileSync(tmpPath, JSON.stringify(validated, null, 2))
  renameSync(tmpPath, finalPath)
}

/** Update just the system prompt for a group. Returns false if group doesn't exist. */
export function updateGroupPrompt(chatId: number, systemPrompt: string): boolean {
  const ctx = getGroupContext(chatId)
  if (!ctx) return false
  ctx.systemPrompt = systemPrompt
  setGroupContext(chatId, ctx)
  return true
}

/** Allowed model ids for group subagent overrides. */
export const ALLOWED_MODELS = ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'] as const
export type AllowedModel = typeof ALLOWED_MODELS[number]

/** Update just the model for a group. Returns false if group doesn't exist. Throws on invalid model. */
export function updateGroupModel(chatId: number, model: AllowedModel): boolean {
  if (!ALLOWED_MODELS.includes(model)) {
    throw new Error(`invalid model: ${model}`)
  }
  const ctx = getGroupContext(chatId)
  if (!ctx) return false
  ctx.model = model
  setGroupContext(chatId, ctx)
  return true
}

/**
 * Build a draft GroupContext from a free-form description by keyword-guessing
 * the type and using that type's default prompt template. Pure function.
 */
export function draftConfigFromDescription(description: string): GroupContext {
  const d = description.toLowerCase()
  let type: GroupType = 'basic'
  if (/\b(cod(e|ing)|repo|bug|debug|refactor|implement|pr|pull request|test|build|compile|typescript|python|rust|go\b)/.test(d)) {
    type = 'coding'
  } else if (/\b(quick|fast|short|simple|brief|q\s*&\s*a|qa|ask)/.test(d)) {
    type = 'quick'
  }
  const t = GROUP_TYPES[type]

  // Extract purpose-only name by removing preamble words like "I want a", "create a", "need a".
  let name = description.trim()
  // Remove common preamble patterns (case-insensitive)
  name = name.replace(/^(i\s+want\s+[an\s]+|create\s+[an\s]+|i\s+need\s+[an\s]+|set\s+up\s+[an\s]+|make\s+[an\s]+)/i, '')
  // Take first few words (up to 4)
  name =
    name
      .split(/\s+/)
      .slice(0, 4)
      .join(' ')
      .replace(/[^\w\s-]/g, '')
      .trim() || `${t.label} Agent`

  // Title-case the name
  name = name
    .split(/\s+/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')

  // If name doesn't already end with "Agent" or "Assistant", append "Agent"
  if (!/\b(agent|assistant)$/i.test(name)) {
    name += ' Agent'
  }

  return {
    type,
    name,
    description,
    systemPrompt: t.defaultPrompt,
    model: t.model,
    inheritClaudeMd: t.inheritClaudeMd,
    createdAt: new Date().toISOString(),
  }
}
