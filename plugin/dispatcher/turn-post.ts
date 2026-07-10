/**
 * Shared "post the turn result back to the chat" helper (#128).
 *
 * Exactly two call sites used to post a subagent turn's final text —
 * runSubagentTurn and the scheduler wrapper — while every other dispatch
 * path (native-moment offers, edit-as-interrupt, file-reviewer comment
 * turns, teleport import summaries) awaited the turn and silently
 * discarded `result.text` and the policy-denial summary. Those journeys
 * looked dead to the user even though the subagent did the work.
 *
 * Every dispatch path that expects the user to see the outcome must post
 * through this helper so the behavior can't drift per-site again.
 */

export interface TurnResultLike {
  text: string
  denials: Array<{ tool_name?: string; command?: string }>
}

/**
 * Format the end-of-turn "blocked by policy" summary, or null when there
 * is nothing to report. Kept identical to the historical inline format so
 * existing users see no copy change.
 */
export function denialSummary(denials: TurnResultLike['denials']): string | null {
  if (denials.length === 0) return null
  const lines = denials
    .map((d) => `• ${d.tool_name}${d.command ? ': ' + d.command.slice(0, 80) : ''}`)
    .join('\n')
  return `⚠️ Some actions were blocked by policy:\n${lines}`
}

/**
 * Post a turn's final text and (separately) its denial summary to the
 * chat. A failure sending the text does not swallow the denial summary —
 * both sends are attempted, then the first error is rethrown so callers
 * keep their existing error handling.
 */
export async function postTurnResult(
  send: (chatId: number, text: string) => Promise<unknown>,
  chatId: number,
  result: TurnResultLike,
): Promise<void> {
  let firstError: unknown = null
  if (result.text) {
    try {
      await send(chatId, result.text)
    } catch (err) {
      firstError = err
    }
  }
  const summary = denialSummary(result.denials)
  if (summary) {
    try {
      await send(chatId, summary)
    } catch (err) {
      if (firstError === null) firstError = err
    }
  }
  if (firstError !== null) throw firstError
}
