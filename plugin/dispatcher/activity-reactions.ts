/**
 * Activity reactions for skip-permissions subagents.
 *
 * Holds per-chat "current turn target message" state and emits a
 * single DC reaction per tool class, debounced so that e.g. five Read
 * calls in a row only produce one 🔍. Only reachable from the
 * tryAutoApprove success path, so permission-card agents are
 * automatically excluded — the permission prompt itself is the preview.
 */

const EMOJI_CODING = '\u{1F468}\u{200D}\u{1F4BB}'   // 👨‍💻
const EMOJI_READING = '\u{1F50D}'                    // 🔍
const EMOJI_RUNNING = '\u2699\uFE0F'                 // ⚙️
const EMOJI_WEB = '\u{1F310}'                        // 🌐
const EMOJI_PLANNING = '\u270D\uFE0F'                // ✍️
const EMOJI_DELEGATING = '\u{1F91D}'                 // 🤝

const CODING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const READING_TOOLS = new Set(['Read', 'Grep', 'Glob'])
const WEB_TOOLS = new Set(['WebFetch', 'WebSearch'])

/**
 * Compute the emoji to react with for a given tool invocation.
 * Returns null for dc_* tools (noise), dc_react (would loop), and
 * unknown tools. TodoWrite is handled separately via todoStepEmoji.
 */
export function computeEmoji(toolName: string, toolInput: unknown): string | null {
  if (toolName.startsWith('dc_')) return null
  if (CODING_TOOLS.has(toolName)) return EMOJI_CODING
  if (READING_TOOLS.has(toolName)) return EMOJI_READING
  if (toolName === 'Bash') return EMOJI_RUNNING
  if (WEB_TOOLS.has(toolName)) return EMOJI_WEB
  if (toolName === 'ExitPlanMode') return EMOJI_PLANNING
  if (toolName === 'Task') return EMOJI_DELEGATING
  if (toolName === 'TodoWrite') return todoStepEmoji(toolInput)
  return null
}

/**
 * Map a TodoWrite payload to a step-progress emoji: 1️⃣–9️⃣ for
 * indices 0–8, regional indicators 🇦–🇿 for indices 9–34. Returns
 * null when there is no in_progress todo, the index is out of range,
 * or the payload shape is unexpected.
 */
export function todoStepEmoji(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const todos = (input as { todos?: unknown }).todos
  if (!Array.isArray(todos)) return null
  const idx = todos.findIndex(
    (t) => t && typeof t === 'object' && (t as { status?: string }).status === 'in_progress',
  )
  if (idx < 0) return null
  if (idx < 9) {
    // Keycap sequence: DIGIT + VS16 + COMBINING ENCLOSING KEYCAP
    return `${String(idx + 1)}\uFE0F\u20E3`
  }
  const letterIdx = idx - 9
  if (letterIdx >= 26) return null
  // Regional indicator A..Z starts at U+1F1E6
  return String.fromCodePoint(0x1F1E6 + letterIdx)
}

export interface ActivityReactor {
  /** Call at the start of a turn with the user's message id. */
  setTurnTarget(chatId: number, msgId: number): void
  /** Call in the turn's finally block to drop state (leaves last emoji visible). */
  clearTurnTarget(chatId: number): void
  /**
   * Call from the auto-approve path with the about-to-run tool name.
   * No-op when the chat has no turn target or the tool maps to no emoji.
   * Fire-and-forget — the DC reaction RPC is dispatched asynchronously so
   * the caller never blocks.
   */
  reactForTool(chatId: number, toolName: string, toolInput: unknown): void
}

export interface ActivityReactorDeps {
  sendReaction: (msgId: number, emoji: string) => Promise<void>
  logf?: (fmt: string, ...args: unknown[]) => void
}

interface TurnState {
  msgId: number
  lastEmoji: string | null
}

export function createActivityReactor(deps: ActivityReactorDeps): ActivityReactor {
  const state = new Map<number, TurnState>()
  const log = deps.logf ?? (() => {})

  return {
    setTurnTarget(chatId, msgId) {
      state.set(chatId, { msgId, lastEmoji: null })
    },
    clearTurnTarget(chatId) {
      state.delete(chatId)
    },
    reactForTool(chatId, toolName, toolInput) {
      const entry = state.get(chatId)
      if (!entry) return
      const emoji = computeEmoji(toolName, toolInput)
      if (!emoji) return
      if (emoji === entry.lastEmoji) return
      entry.lastEmoji = emoji
      const { msgId } = entry
      deps.sendReaction(msgId, emoji).catch((err) => {
        log('activity-reactions: sendReaction failed chat=%d msg=%d: %v', chatId, msgId, err)
      })
    },
  }
}
