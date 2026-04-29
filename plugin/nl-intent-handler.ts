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
}

/**
 * Act on a classified intent. Caller has already filtered out `null`
 * (no intent matched) and decided this turn shouldn't reach the
 * subagent — we just persist the change, evict the cached subagent so
 * it picks up the new config on next dispatch, and confirm in chat.
 *
 * Refine is currently a placeholder; the full Refine flow lands in a
 * later phase (re-opens coach with the existing prompt as context).
 */
export async function handleNlIntent(
  deps: NlIntentDeps,
  intent: Exclude<Intent, null>,
  chatId: number,
): Promise<void> {
  const { send, evictChat, refreshIcon, logf } = deps
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
      // Placeholder — the full Refine flow (reopen coach with the
      // existing prompt as context) lands in a later phase.
      await send(
        chatId,
        "(preview) Refine isn't wired up yet — coming in the next release. Until then, edit the agent via the agent settings card.",
      ).catch(() => {})
      return
    }
  }
}
