/**
 * Authorize high-stakes webXDC *control* commands (teleport-out, role
 * assignment, agent edit/delete, …) on the only authenticated identity DC
 * offers: the message envelope. webXDC `senderAddr` is app-relayed and
 * spoofable (verified, dc-core 2.53 — see spec §6 / GH #110), so it is NEVER
 * the basis for authorization.
 *
 * Model (account-holder-only):
 *  - Solo group (owner + bot, no other human): the owner is the only human who
 *    could have driven the card → act directly. The common D4C case.
 *  - Multi-human group: a webXDC tap has NO authenticated author — `onWebXDCUpdate`
 *    events are not chat messages and do NOT update `_currentDriver`. Any
 *    `currentDriver` value reflects only the last *message* sender, which is
 *    unauthenticated with respect to the tap. Therefore we ALWAYS refuse with
 *    `needs-confirmation` in multi-human groups and require the owner to send
 *    an authenticated chat-message command instead (ref GH #114).
 */

export interface ControlAuthDeps {
  humanMemberCount: (chatId: number) => Promise<number>
  owner: (chatId: number) => number | null
}

/**
 * Count the HUMAN members of a chat for the multi-human §6 gate. Excludes
 * CONTACT_SELF (the bot, id 1) AND any other bots/agents in the chat.
 *
 * Why bots must not count: the gate exists to disambiguate *which human*
 * tapped an unauthenticated webXDC card — a bot can't be that tapper. The old
 * inline count (`contacts.filter(id => id !== 1).length`) counted every
 * non-self contact, so a chat of `owner + Claude + one other agent/bot` read
 * as multi-human and wrongly refused the owner's own card taps with
 * `needs-confirmation`, even though the owner is the ONLY human present.
 */
export async function countHumanMembers(
  getChatContacts: (chatId: number) => Promise<number[]>,
  isBot: (contactId: number) => Promise<boolean>,
  chatId: number,
): Promise<number> {
  const nonSelf = (await getChatContacts(chatId)).filter(id => id !== 1)
  const botFlags = await Promise.all(nonSelf.map(id => isBot(id).catch(() => false)))
  return nonSelf.filter((_, i) => !botFlags[i]).length
}

export async function isControlCommandAuthorized(
  chatId: number,
  deps: ControlAuthDeps,
): Promise<{ ok: true } | { ok: false; reason: 'no-owner' | 'needs-confirmation' }> {
  const owner = deps.owner(chatId)
  if (owner == null) return { ok: false, reason: 'no-owner' }

  const humans = await deps.humanMemberCount(chatId)
  if (humans <= 1) return { ok: true } // solo group: owner is the only human

  // Multi-human: webXDC taps are unauthenticated — always refuse and require
  // the owner to confirm via an authenticated chat message.
  return { ok: false, reason: 'needs-confirmation' }
}
