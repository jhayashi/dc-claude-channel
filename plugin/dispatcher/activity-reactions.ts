/**
 * Activity reactions — live emoji indicators for subagent tool use.
 *
 * Holds per-chat "current turn target message" state and emits a
 * single DC reaction per tool class, debounced so that e.g. five Read
 * calls in a row only produce one reaction. Reactions fire for ALL
 * agents (skip-permissions and permission-card) so the user always
 * sees what Claude is doing. A random thinking emoji is emitted at
 * turn start before any tool fires.
 *
 * Palette (#65, v1.2.2):
 *   thinking   — turn-start indicator AND merged read/plan tools.
 *                Read/Grep/Glob/LS and EnterPlanMode/ExitPlanMode are
 *                indistinguishable from "subagent is figuring something
 *                out" from the user's POV; collapsing them lets the
 *                richer pool stay visible without competing classes.
 *   coding     — Edit/Write/MultiEdit/NotebookEdit
 *   running   — Bash
 *   web       — WebFetch/WebSearch
 *   delegating — Agent/Task
 *   todo-step  — TodoWrite (one class per index, never debounced)
 *
 * AI-magic emojis (✨ 🔮 🪄) intentionally NOT in any pool — they
 * undercut the "actually doing work" tone of the rest of the palette.
 *
 * Note on user-visible firing rate: REACTION_DEBOUNCE_MS (60s) caps
 * reactions to one per chat per minute, so on a fast multi-tool turn
 * (most turns) only the turn-start thinking emoji fires. Class diversity
 * matters for slow turns (>60s with mixed tools) and for visual
 * differentiation when the time-window opens.
 */

export const CODING_EMOJIS = [
  '\u{1FAA1}',   // 🪡 Sewing needle
  '✏️', // ✏️ Pencil
  '\u{1F58A}️', // 🖊️ Pen
  '\u{1F3A8}',   // 🎨 Artist palette
]
export const RUNNING_EMOJIS = [
  '⚙️', // ⚙️ Gear
  '\u{1F4A5}',   // 💥 Collision
  '\u{1F528}',   // 🔨 Hammer
  '\u{1F527}',   // 🔧 Wrench
  '⛏️', // ⛏️ Pick
]
const EMOJI_WEB = '\u{1F310}'                        // 🌐
const EMOJI_DELEGATING = '\u{1F91D}'                 // 🤝
export const THINKING_EMOJIS = [
  '\u{1F914}',                    // 🤔
  '\u{1F4AD}',                    // 💭
  '\u{1F9E0}',                    // 🧠
  '\u{1F468}\u{200D}\u{1F373}',  // 👨‍🍳
  '\u{1F9D1}\u{200D}\u{1F373}',  // 🧑‍🍳
  '\u{1F4A1}',                    // 💡
  '\u{1F937}',                    // 🤷
  '⚡',                       // ⚡
  '\u{1F47E}',                    // 👾
  // Merged-in reading set (#65): Read/Grep/Glob/LS map here.
  '\u{1F50D}',                    // 🔍 Magnifying glass left
  '\u{1F50E}',                    // 🔎 Magnifying glass right
  '\u{1F440}',                    // 👀 Eyes
  '\u{1F9D0}',                    // 🧐 Monocle face
  '\u{1F441}️',              // 👁️ Single eye
]

const CODING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const READING_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS'])
const WEB_TOOLS = new Set(['WebFetch', 'WebSearch'])

/**
 * Compute the emoji class and a random emoji for a tool invocation.
 * Returns null for dc_* tools (noise), dc_react (would loop), and
 * unknown tools. The class string is used for debouncing (same class
 * = same visual category), while the emoji is what gets displayed.
 */
function pick(pool: string[]): string {
  return pool[Math.floor(Math.random() * pool.length)]
}

export function computeEmoji(toolName: string, toolInput: unknown): { cls: string; emoji: string } | null {
  if (toolName.startsWith('dc_')) return null
  if (CODING_TOOLS.has(toolName)) return { cls: 'coding', emoji: pick(CODING_EMOJIS) }
  if (READING_TOOLS.has(toolName)) return { cls: 'thinking', emoji: pick(THINKING_EMOJIS) }
  if (toolName === 'Bash') return { cls: 'running', emoji: pick(RUNNING_EMOJIS) }
  if (WEB_TOOLS.has(toolName)) return { cls: 'web', emoji: EMOJI_WEB }
  if (toolName === 'EnterPlanMode' || toolName === 'ExitPlanMode') return { cls: 'thinking', emoji: pick(THINKING_EMOJIS) }
  if (toolName === 'Agent' || toolName === 'Task') return { cls: 'delegating', emoji: EMOJI_DELEGATING }
  if (toolName === 'TodoWrite') { const e = todoStepEmoji(toolInput); return e ? { cls: `todo-${e}`, emoji: e } : null }
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
    return `${String(idx + 1)}️⃣`
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
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number
  /** Optional logf for diagnostics; ignored by current implementation. */
  logf?: (format: string, ...args: unknown[]) => void
}

/**
 * Minimum time between reactions per chat. Each subagent tool call would
 * otherwise emit its own reaction; on long multi-step turns that easily
 * generates 30–50 reactions per user message, each one a separate
 * encrypted SMTP send. Throttling to one per minute keeps the chatmail
 * server from rate-limiting the account.
 */
export const REACTION_DEBOUNCE_MS = 60_000

interface TurnState {
  msgId: number
  lastClass: string | null
  lastFiredAtMs: number
}

export function createActivityReactor(deps: ActivityReactorDeps): ActivityReactor {
  const state = new Map<number, TurnState>()
  const now = deps.now ?? (() => Date.now())

  return {
    setTurnTarget(chatId, msgId) {
      const emoji = THINKING_EMOJIS[Math.floor(Math.random() * THINKING_EMOJIS.length)]
      state.set(chatId, { msgId, lastClass: 'thinking', lastFiredAtMs: now() })
      // Fire-and-forget thinking indicator before any tool fires.
      deps.sendReaction(msgId, emoji).catch(() => {})
    },
    clearTurnTarget(chatId) {
      state.delete(chatId)
    },
    reactForTool(chatId, toolName, toolInput) {
      const entry = state.get(chatId)
      if (!entry) return
      const result = computeEmoji(toolName, toolInput)
      if (!result) return
      if (result.cls === entry.lastClass) return
      entry.lastClass = result.cls
      const t = now()
      if (t - entry.lastFiredAtMs < REACTION_DEBOUNCE_MS) return
      entry.lastFiredAtMs = t
      const { msgId } = entry
      deps.sendReaction(msgId, result.emoji).catch(() => {})
    },
  }
}
