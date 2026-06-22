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
