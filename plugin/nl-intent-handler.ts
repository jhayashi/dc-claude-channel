/**
 * Dispatcher-side handler for NL meta-commands ("switch to opus" / "trust
 * me" / "let's refine you"). Pulled out of server.ts so the no-binding
 * paths and confirmation copy are unit-testable without spinning up a
 * full dispatcher.
 *
 * Production wires deps from main(): the real DCClient.send, the active
 * SubagentCache.evictChat, and a refreshIcon thunk that calls
 * setAgentIcon under best-effort error handling.
 */

import * as agents from './agents.js'
import * as bindings from './bindings.js'
import type { Intent } from './nl-intents.js'

export interface NlIntentDeps {
  send: (chatId: number, text: string) => Promise<unknown>
  evictChat: (chatId: number) => Promise<unknown>
  refreshIcon: (chatId: number, agentId: string) => void
  logf: (fmt: string, ...args: unknown[]) => void
  /**
   * Start a Refine coach session for `chatId` over the named agent.
   * Wired in production to startRefineCoach + coachSessions.set in
   * server.ts. Returns the first question (already sent? caller's
   * choice — we send it from handleNlIntent via `send` to keep the
   * confirmation-reply pattern consistent across intents).
   * Returns null if the session couldn't be started (e.g. one already
   * exists for this chat).
   */
  startRefineSession: (chatId: number, agentId: string) => Promise<string | null>
}

/**
 * Act on a classified intent. Caller has already filtered out `null`
 * (no intent matched) and decided this turn shouldn't reach the
 * subagent — we just persist the change, evict the cached subagent so
 * it picks up the new config on next dispatch, and confirm in chat.
 *
 * Refine kicks off a single-question coach session over the existing
 * bound agent — see startRefineCoach + graduateRefineSession.
 */
export async function handleNlIntent(
  deps: NlIntentDeps,
  intent: Exclude<Intent, null>,
  chatId: number,
): Promise<void> {
  const { send, evictChat, refreshIcon, logf, startRefineSession } = deps
  switch (intent.kind) {
    case 'model-switch': {
      const binding = bindings.getBinding(chatId)
      if (!binding?.agentId) {
        await send(chatId, "I'm not bound to an agent yet, so model-switch doesn't apply here.").catch(() => {})
        return
      }
      try {
        agents.setAgentModel(binding.agentId, intent.tier)
        // Evict the cached subagent so the next message cold-spawns
        // under the new model. Matches the dc_update_agent eviction
        // pattern. evictChat is a no-op if no subagent is cached.
        await evictChat(chatId).catch((err) =>
          logf('nl-intent: model-switch evict failed chat=%d: %v', chatId, err),
        )
        await send(chatId, `Switched to ${intent.tier}. The change takes effect on the next message.`)
        // Best-effort badge refresh so the tier color updates immediately.
        refreshIcon(chatId, binding.agentId)
      } catch (err) {
        logf('nl-intent: model-switch failed chat=%d tier=%s: %v', chatId, intent.tier, err)
        await send(chatId, `Couldn't switch to ${intent.tier}: ${err instanceof Error ? err.message : 'unknown error'}`).catch(() => {})
      }
      return
    }
    case 'trust-toggle': {
      const binding = bindings.getBinding(chatId)
      if (!binding?.agentId) {
        await send(chatId, "I'm not bound to an agent yet, so trust-toggle doesn't apply here.").catch(() => {})
        return
      }
      try {
        agents.setAgentTrust(binding.agentId, intent.value)
        await evictChat(chatId).catch((err) =>
          logf('nl-intent: trust-toggle evict failed chat=%d: %v', chatId, err),
        )
        await send(
          chatId,
          intent.value
            ? "Trust on — I'll skip permission prompts on the next message."
            : "Trust off — I'll ask before running tools on the next message.",
        )
        refreshIcon(chatId, binding.agentId)
      } catch (err) {
        logf('nl-intent: trust-toggle failed chat=%d value=%s: %v', chatId, intent.value, err)
        await send(chatId, `Couldn't update trust: ${err instanceof Error ? err.message : 'unknown error'}`).catch(() => {})
      }
      return
    }
    case 'refine': {
      const binding = bindings.getBinding(chatId)
      if (!binding?.agentId) {
        await send(chatId, "I'm not bound to an agent yet, so refine doesn't apply here.").catch(() => {})
        return
      }
      try {
        const firstQuestion = await startRefineSession(chatId, binding.agentId)
        if (firstQuestion === null) {
          await send(
            chatId,
            "I'm in the middle of something else right now — let's finish that first.",
          ).catch(() => {})
          return
        }
        await send(chatId, firstQuestion)
      } catch (err) {
        logf('nl-intent: refine start failed chat=%d agent=%s: %v', chatId, binding.agentId, err)
        await send(
          chatId,
          `Couldn't start refine: ${err instanceof Error ? err.message : 'unknown error'}`,
        ).catch(() => {})
      }
      return
    }
  }
}
