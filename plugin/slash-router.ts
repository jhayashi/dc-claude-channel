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

export type SlashCommand =
  | { kind: 'help' }
  | { kind: 'stop' }
  | { kind: 'clear' }
  | { kind: 'memory'; subcommand?: 'show'; key?: string }
  | { kind: 'mcp' }
  | { kind: 'plugin' }

// Match /cmd or /cmd <rest> at the start of a trimmed message.
// Only letters, digits, and hyphens after the slash — no "//" or "/ ".
const SLASH_RE = /^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]+))?$/i

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
    default:
      return null
  }
}

/**
 * Call-site gate: skip slash classification when a chat is in coach-mode.
 * Same gate contract as shouldClassify in nl-intents.ts.
 */
export function shouldClassifySlash(chatId: number, appSessions: Map<number, unknown>): boolean {
  return !appSessions.has(chatId)
}
