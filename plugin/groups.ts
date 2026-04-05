/**
 * Group context store — maps Delta Chat group chat IDs to behavior prompts.
 *
 * Each group has a short prompt that tells Claude how to handle messages
 * in that group (e.g., "Summarize any links shared. Tag by topic.").
 *
 * State stored in ~/.claude/channels/deltachat/groups/<chatId>.json
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const GROUPS_DIR = join(homedir(), '.claude', 'channels', 'deltachat', 'groups')

export interface GroupContext {
  name: string
  prompt: string
}

/** Get the context for a group, or null if not a managed group. */
export function getGroupContext(chatId: number): GroupContext | null {
  const path = join(GROUPS_DIR, `${chatId}.json`)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as GroupContext
  } catch {
    return null
  }
}

/** Save context for a group. */
export function setGroupContext(chatId: number, ctx: GroupContext): void {
  mkdirSync(GROUPS_DIR, { recursive: true })
  writeFileSync(join(GROUPS_DIR, `${chatId}.json`), JSON.stringify(ctx, null, 2))
}

/** Update just the prompt for a group. Returns false if group doesn't exist. */
export function updateGroupPrompt(chatId: number, prompt: string): boolean {
  const ctx = getGroupContext(chatId)
  if (!ctx) return false
  ctx.prompt = prompt
  setGroupContext(chatId, ctx)
  return true
}
