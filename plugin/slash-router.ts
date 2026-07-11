/**
 * Slash-command classifier for in-chat commands the dispatcher handles
 * before subagent dispatch. Each `/cmd [args]` pattern maps to a typed
 * SlashCommand; unrecognised slashes return null and fall through to the
 * subagent unchanged.
 *
 * Pure function; deterministic given input. The dispatcher gates this
 * via shouldClassifySlash(chatId, appSessions) so coach-in-flight
 * messages land in the coach state machine, not the classifier.
 */

import { BLOCKED_COMMANDS } from './slash-commands.js'

export type SlashCommand =
  | { kind: 'help' }
  | { kind: 'stop' }
  | { kind: 'clear' }
  | { kind: 'memory'; subcommand?: 'show'; key?: string }
  | { kind: 'mcp' }
  | { kind: 'plugin' }
  | { kind: 'model'; tier: 'haiku' | 'sonnet' | 'opus' | null }
  | { kind: 'effort'; level: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null | 'reset'; raw?: string }
  | { kind: 'compact' }
  | { kind: 'usage' }
  | { kind: 'think'; prompt: string }
  | { kind: 'ultrathink'; prompt: string }
  | { kind: 'plan'; prompt: string }
  | { kind: 'exit-plan' }
  | { kind: 'blocked'; cmd: string }
  | { kind: 'unknown-slash'; cmd: string; args: string }

// Match /cmd or /cmd <rest> at the start of a trimmed message.
// Only letters, digits, and hyphens after the slash — no "//" or "/ ".
const SLASH_RE = /^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]+))?$/i

// Commands that exist in the terminal CLI but have no equivalent in DC chat.
// These return a 'blocked' command so the dispatcher can explain why.
// #108 increment 1: the canonical list lives in slash-commands.ts (the
// single documented table that also generates HELP_TEXT and the help card).
const BLOCKED_SLASHES = new Set(BLOCKED_COMMANDS)

export function classifySlash(text: string): SlashCommand | null {
  const t = text.trim()
  if (!t.startsWith('/')) return null

  const m = SLASH_RE.exec(t)
  if (!m) return null

  const cmd = m[1].toLowerCase()
  const rest = (m[2] ?? '').trim()

  switch (cmd) {
    case 'help':
      return { kind: 'help' }
    case 'stop':
      return { kind: 'stop' }
    case 'clear':
      return { kind: 'clear' }
    case 'mcp':
      return { kind: 'mcp' }
    case 'plugin':
    case 'plugins':
      return { kind: 'plugin' }
    case 'memory': {
      if (!rest) return { kind: 'memory' }
      const parts = rest.split(/\s+/)
      if (parts[0] === 'show' && parts[1]) {
        return { kind: 'memory', subcommand: 'show', key: parts[1] }
      }
      // Bare `/memory <key>` is shorthand for `/memory show <key>`.
      return { kind: 'memory', subcommand: 'show', key: parts[0] }
    }
    case 'model': {
      if (!rest) return { kind: 'model', tier: null }
      const tier = rest.split(/\s+/)[0].toLowerCase()
      if (tier === 'haiku' || tier === 'sonnet' || tier === 'opus') {
        return { kind: 'model', tier }
      }
      return { kind: 'model', tier: null }
    }
    case 'effort': {
      if (!rest) return { kind: 'effort', level: null }
      const arg = rest.split(/\s+/)[0].toLowerCase()
      if (arg === 'none' || arg === 'default' || arg === 'reset') {
        return { kind: 'effort', level: 'reset' }
      }
      if (arg === 'low' || arg === 'medium' || arg === 'high' || arg === 'xhigh' || arg === 'max') {
        return { kind: 'effort', level: arg }
      }
      // Unknown level → null + raw so the handler can show usage with the user's input.
      return { kind: 'effort', level: null, raw: arg }
    }
    case 'compact':
      return { kind: 'compact' }
    case 'usage':
    case 'cost':
      return { kind: 'usage' }
    case 'think':
      return { kind: 'think', prompt: rest }
    case 'ultrathink':
      return { kind: 'ultrathink', prompt: rest }
    case 'plan':
      return { kind: 'plan', prompt: rest }
    case 'exit-plan':
      return { kind: 'exit-plan' }
    default:
      if (BLOCKED_SLASHES.has(cmd)) return { kind: 'blocked', cmd }
      return { kind: 'unknown-slash', cmd, args: rest }
  }
}

/**
 * Call-site gate: skip slash classification when a chat is in coach-mode.
 * Same gate contract as shouldClassify in nl-intents.ts.
 */
export function shouldClassifySlash(chatId: number, appSessions: Map<number, unknown>): boolean {
  return !appSessions.has(chatId)
}
