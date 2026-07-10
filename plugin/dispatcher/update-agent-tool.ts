/**
 * dc_update_agent handler, extracted from server.ts's tailHandlers map
 * (#135 / #137 fix-carries-its-seam). Adds the `name` parameter — the
 * Appendix A "rename yourself to Atlas" execute lane: writes
 * `x-dc-display-name` (the slug/filename is pinned; a rename never moves
 * the .md), refreshes each bound chat's badge + name, and needs no
 * subagent restart (display-only). prompt/model keep their existing
 * evict-others-defer-caller semantics.
 */

import * as agents from '../agents.js'
import * as bindings from '../bindings.js'
import type { ToolResult } from './dc-tools.js'

export interface UpdateAgentToolDeps {
  evictChat(chatId: number): Promise<void>
  /** Best-effort chat-name + badge refresh after a display rename. */
  refreshChatDecoration(chatId: number, agentName: string): Promise<void>
  logf(fmt: string, ...args: unknown[]): void
}

export async function handleUpdateAgentTool(
  deps: UpdateAgentToolDeps,
  args: Record<string, unknown>,
  callerChatId?: number,
): Promise<ToolResult> {
  const chatId = Number(args.chat_id as string)
  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
  const model = typeof args.model === 'string' ? args.model.trim() : ''
  const displayName = typeof args.name === 'string' ? args.name.trim() : ''
  if (!chatId || Number.isNaN(chatId)) {
    return { content: [{ type: 'text' as const, text: 'dc_update_agent: chat_id is required' }], isError: true }
  }
  if (!prompt && !model && !displayName) {
    return { content: [{ type: 'text' as const, text: 'dc_update_agent: at least one of prompt, model, or name must be provided' }], isError: true }
  }
  if (model && !agents.ALLOWED_MODELS.includes(model as agents.AllowedModel)) {
    return { content: [{ type: 'text' as const, text: `dc_update_agent: invalid model "${model}". Allowed: ${agents.ALLOWED_MODELS.join(', ')}` }], isError: true }
  }
  const resolved = bindings.resolveChat(chatId)
  if (!resolved) {
    return { content: [{ type: 'text' as const, text: `No agent configured for chat ${chatId}. Use dc_open_agent_manage_card first.` }], isError: true }
  }
  const agentId = resolved.agent.name
  const changes: string[] = []
  if (prompt) {
    if (!agents.updateAgentPrompt(agentId, prompt)) {
      return { content: [{ type: 'text' as const, text: `Agent ${agentId} not found.` }], isError: true }
    }
    changes.push('prompt')
  }
  if (model) {
    if (!agents.updateAgentModel(agentId, model as agents.AllowedModel)) {
      return { content: [{ type: 'text' as const, text: `Agent ${agentId} not found.` }], isError: true }
    }
    changes.push(`model=${model}`)
  }
  if (displayName) {
    if (!agents.updateAgentDisplayName(agentId, displayName)) {
      return { content: [{ type: 'text' as const, text: `Agent ${agentId} not found.` }], isError: true }
    }
    changes.push(`name="${displayName}"`)
  }

  const affected = bindings.listBindings().filter(b => b.agentId === agentId)

  // Display rename is cosmetic — refresh each bound chat's name + badge,
  // no restart needed. prompt/model require a respawn: evict every bound
  // chat EXCEPT the caller's (its subagent finishes this response and
  // picks up the change on the next message).
  const needsRestart = Boolean(prompt || model)
  await Promise.all(
    affected.map(async b => {
      if (displayName) {
        await deps.refreshChatDecoration(b.chatId, agentId).catch(err =>
          deps.logf('dc_update_agent: decoration refresh failed chat=%d: %v', b.chatId, err),
        )
      }
      if (!needsRestart) return
      if (b.chatId === callerChatId) {
        deps.logf('dc_update_agent: deferring evict of caller chat %d (will respawn on next message)', b.chatId)
        return
      }
      await deps.evictChat(b.chatId).catch(err =>
        deps.logf('dc_update_agent: evict failed chat=%d: %v', b.chatId, err),
      )
    }),
  )
  return { content: [{ type: 'text' as const, text: `Updated ${changes.join(', ')} for agent ${agentId} (${affected.length} chat(s) bound).` }] }
}
