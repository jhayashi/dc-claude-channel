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
 *  - Multi-human group: the webXDC update's author can't be authenticated, so
 *    require that the chat's most recent message came from the owner
 *    (`_currentDriver` === owner) — i.e. an owner `fromId` confirmation. Else
 *    refuse with `needs-confirmation` and the caller asks the owner to confirm
 *    in chat.
 */

export interface ControlAuthDeps {
  humanMemberCount: (chatId: number) => Promise<number>
  owner: (chatId: number) => number | null
  currentDriver: (chatId: number) => number | null
}

export async function isControlCommandAuthorized(
  chatId: number,
  deps: ControlAuthDeps,
): Promise<{ ok: true } | { ok: false; reason: 'no-owner' | 'needs-confirmation' }> {
  const owner = deps.owner(chatId)
  if (owner == null) return { ok: false, reason: 'no-owner' }

  const humans = await deps.humanMemberCount(chatId)
  if (humans <= 1) return { ok: true } // solo group: owner is the only human

  // Multi-human: require an authenticated owner confirmation via the last message.
  if (deps.currentDriver(chatId) === owner) return { ok: true }
  return { ok: false, reason: 'needs-confirmation' }
}
