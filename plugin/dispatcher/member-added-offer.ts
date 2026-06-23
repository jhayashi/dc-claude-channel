/**
 * Decide whether to proactively offer to set a newly-added member's
 * permissions (settings-decomposition native moment). Pure — server.ts
 * gathers the booleans (is this an agent chat? is the new member already
 * permissioned? is the new member the bot itself?) and acts on the result.
 */
export function shouldOfferPermissions(args: {
  isAgentChat: boolean
  newMemberPermissioned: boolean
  newMemberIsBotSelf: boolean
}): { offer: boolean; reason: string } {
  if (!args.isAgentChat) return { offer: false, reason: 'not-an-agent-chat' }
  if (args.newMemberIsBotSelf) return { offer: false, reason: 'bot-self' }
  if (args.newMemberPermissioned) return { offer: false, reason: 'already-permissioned' }
  return { offer: true, reason: 'unpermissioned-human-joined' }
}

/**
 * Decide whether to proactively offer to SET UP AN AGENT for a chat — the
 * marquee group-created native moment. Pure: server.ts gathers whether the
 * bot was the just-added member and whether the chat already has an agent.
 */
export function shouldOfferAgentSetup(args: {
  botWasAdded: boolean
  chatHasAgent: boolean
}): { offer: boolean; reason: string } {
  if (!args.botWasAdded) return { offer: false, reason: 'bot-not-added' }
  if (args.chatHasAgent) return { offer: false, reason: 'agent-already-bound' }
  return { offer: true, reason: 'bot-joined-agentless-group' }
}
