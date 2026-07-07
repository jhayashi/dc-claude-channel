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

/**
 * From the unpermissioned human members of an agent chat, pick those we have
 * NOT already offered permissions for. The caller offers for the first result
 * and marks them all offered. (#117)
 *
 * DC's `MemberAddedToGroup` message doesn't expose which contact was just
 * added, so without this a lingering unpermissioned member re-triggers the
 * offer — and gets named in it — on every later member-add. Deduping by
 * already-offered members keeps the offer to genuinely-new members and stops
 * the spam. Pure: `alreadyOffered` is injected so it unit-tests without state.
 */
export function freshPermissionOfferTargets(
  unpermissioned: readonly number[],
  alreadyOffered: (contactId: number) => boolean,
): number[] {
  return unpermissioned.filter((id) => !alreadyOffered(id))
}
