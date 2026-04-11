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
 * Stub — real implementation in Task 2.
 */
export function todoStepEmoji(_input: unknown): string | null {
  return null
}
