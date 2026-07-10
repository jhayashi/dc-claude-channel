/**
 * dc_create_agent handler, extracted from server.ts's tailHandlers map
 * (#129 / #137) so the create-a-chat-that-actually-works contract is
 * unit-testable. The #129 bug hid exactly here: the inline handler never
 * seeded the owner's contact record in the new agent's sidecar, so the
 * routing gate silently dropped every message into the fresh chat until
 * the next dispatcher restart backfilled it.
 */

import * as agents from '../agents.js'
import * as bindings from '../bindings.js'
import * as access from '../access/index.js'
import type { ToolResult } from './dc-tools.js'

export interface CreateAgentToolDeps {
  getChatContacts(chatId: number): Promise<number[]>
  createGroup(name: string): Promise<number>
  addContactToChat(chatId: number, contactId: number): Promise<void>
  addChat(chatId: number, contactId: number): void
  /** Send welcome + set icon; receives the saved agent's name. */
  decorate(groupId: number, agentName: string): Promise<void>
  logf(fmt: string, ...args: unknown[]): void
}

export async function handleCreateAgentTool(
  deps: CreateAgentToolDeps,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const name = ((args.name as string) ?? '').trim()
  const prompt = ((args.prompt as string) ?? '').trim()
  const userChatIdStr = args.user_chat_id as string
  if (!name || !prompt || !userChatIdStr) {
    return { content: [{ type: 'text' as const, text: 'dc_create_agent: name, prompt, and user_chat_id are required' }], isError: true }
  }
  const userChatId = Number(userChatIdStr)

  const contacts = await deps.getChatContacts(userChatId)
  const userContactId = contacts.find(id => id !== 1)
  if (!userContactId) {
    return { content: [{ type: 'text' as const, text: 'dc_create_agent: could not find user contact from chat' }], isError: true }
  }

  const groupId = await deps.createGroup(name)
  await deps.addContactToChat(groupId, userContactId)

  deps.addChat(groupId, userContactId)

  // Draft an agent from the free-form prompt, then override with the
  // explicit name/prompt the tool was given. Save agent + bind to chat.
  const modelArg = args.model as string | undefined
  const model = modelArg && agents.ALLOWED_MODELS.includes(modelArg as agents.AllowedModel)
    ? modelArg as agents.AllowedModel
    : undefined
  const { agent: draft, inheritClaudeMd } = agents.draftAgentFromDescription(prompt, model)
  const agentName = agents.synthesizeAgentName(name)
  try {
    agents.saveAgent({
      ...draft,
      name: agentName,
      'x-dc-display-name': name,
      'x-dc-memory-boost': agents.classifyMemoryBoost(prompt),
      body: prompt,
    })
    bindings.bindAgent(groupId, agentName, { inheritClaudeMd })
    // #129: seed the owner's contact record in the NEW agent's sidecar —
    // the routing gate resolves caps against the chat's bound agent, and
    // without a record the fresh chat silently drops every message until
    // the next restart's canonical-seed backfill. Mirrors graduateAgent
    // and handleCreateAgent (#115).
    access.recordContactPair(agentName, userContactId)
  } catch (err) {
    // Roll back so we don't leave a dangling agent or half-bound chat.
    try { agents.deleteAgent(agentName) } catch {}
    try { bindings.deleteBinding(groupId) } catch {}
    return { content: [{ type: 'text' as const, text: `dc_create_agent: failed to persist agent: ${(err as Error).message}` }], isError: true }
  }

  // Send welcome message + set icon so the chat surfaces on the user's device.
  try {
    await deps.decorate(groupId, agentName)
  } catch (err) {
    deps.logf('dc_create_agent: decorate failed chat=%d: %v', groupId, err)
  }

  const result = `Created agent "${name}" (chat ${groupId}, agent_id=${agentName}).`
  return { content: [{ type: 'text' as const, text: result }] }
}
