/**
 * Activity reactions — live emoji indicators for subagent tool use.
 *
 * Holds per-chat "current turn target message" state and emits a
 * single DC reaction per tool class, debounced so that e.g. five Read
 * calls in a row only produce one 🔍. Reactions fire for ALL agents
 * (skip-permissions and permission-card) so the user always sees what
 * Claude is doing. A random thinking emoji is emitted at turn start
 * before any tool fires.
 */

export const CODING_EMOJIS = [
  '\u{1FAA1}',   // 🪡 Sewing needle
  '\u{1FA84}',   // 🪄 Magic wand
  '\u270F\uFE0F', // ✏️ Pencil
  '\u{1F58A}\uFE0F', // 🖊️ Pen
  '\u{1F3A8}',   // 🎨 Artist palette
]
const EMOJI_READING = '\u{1F50D}'                    // 🔍
export const RUNNING_EMOJIS = [
  '\u2699\uFE0F', // ⚙️ Gear
  '\u{1F4A5}',   // 💥 Collision
  '\u{1F528}',   // 🔨 Hammer
  '\u{1F527}',   // 🔧 Wrench
  '\u26CF\uFE0F', // ⛏️ Pick
]
const EMOJI_WEB = '\u{1F310}'                        // 🌐
const EMOJI_PLANNING = '\u270D\uFE0F'                // ✍️
const EMOJI_DELEGATING = '\u{1F91D}'                 // 🤝
export const THINKING_EMOJIS = [
  '\u{1F914}',                    // 🤔
  '\u{1F4AD}',                    // 💭
  '\u{1F9E0}',                    // 🧠
  '\u{1F468}\u{200D}\u{1F373}',  // 👨‍🍳
  '\u{1F9D1}\u{200D}\u{1F373}',  // 🧑‍🍳
  '\u{1F4A1}',                    // 💡
  '\u{1F937}',                    // 🤷
  '\u2728',                       // ✨
  '\u26A1',                       // ⚡
  '\u{1F52E}',                    // 🔮
]

const CODING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const READING_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS'])
const WEB_TOOLS = new Set(['WebFetch', 'WebSearch'])

/**
 * Compute the emoji to react with for a given tool invocation.
 * Returns null for dc_* tools (noise), dc_react (would loop), and
 * unknown tools. TodoWrite is handled separately via todoStepEmoji.
 */
function pick(pool: string[]): string {
  return pool[Math.floor(Math.random() * pool.length)]
}

export function computeEmoji(toolName: string, toolInput: unknown): string | null {
  if (toolName.startsWith('dc_')) return null
  if (CODING_TOOLS.has(toolName)) return pick(CODING_EMOJIS)
  if (READING_TOOLS.has(toolName)) return EMOJI_READING
  if (toolName === 'Bash') return pick(RUNNING_EMOJIS)
  if (WEB_TOOLS.has(toolName)) return EMOJI_WEB
  if (toolName === 'EnterPlanMode' || toolName === 'ExitPlanMode') return EMOJI_PLANNING
  if (toolName === 'Agent' || toolName === 'Task') return EMOJI_DELEGATING
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
  /**
   * Call at the start of a turn with the user's message id.
   * Emits a random thinking emoji so the user gets feedback
   * before the first tool fires (which may take several seconds on
   * slow turns with planning or web fetches).
   */
  setTurnTarget(chatId: number, msgId: number): void
  /** Call in the turn's finally block to drop state (leaves last emoji visible). */
  clearTurnTarget(chatId: number): void
  /**
   * Call from the tool-use path with the about-to-run tool name.
   * No-op when the chat has no turn target or the tool maps to no emoji.
   * Fire-and-forget — the DC reaction RPC is dispatched asynchronously so
   * the caller never blocks.
   */
  reactForTool(chatId: number, toolName: string, toolInput: unknown): void
}

export interface ActivityReactorDeps {
  sendReaction: (msgId: number, emoji: string) => Promise<void>
}

interface TurnState {
  msgId: number
  lastEmoji: string | null
}

export function createActivityReactor(deps: ActivityReactorDeps): ActivityReactor {
  const state = new Map<number, TurnState>()

  return {
    setTurnTarget(chatId, msgId) {
      const emoji = THINKING_EMOJIS[Math.floor(Math.random() * THINKING_EMOJIS.length)]
      state.set(chatId, { msgId, lastEmoji: emoji })
      // Fire-and-forget thinking indicator before any tool fires.
      deps.sendReaction(msgId, emoji).catch(() => {})
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
      deps.sendReaction(msgId, emoji).catch(() => {})
    },
  }
}
