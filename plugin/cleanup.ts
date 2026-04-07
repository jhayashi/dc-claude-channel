/**
 * Chat cleanup decision logic.
 *
 * When a member-removal system message arrives, we decide whether the chat
 * should be cleaned up (deleted + access entry removed + sessions dropped).
 * This module is a pure function to make the decision unit-testable.
 */

/** DC core contact ID for "self". Mirrors the constant in dc-client.ts. */
export const CONTACT_SELF = 1;

export interface CleanupDecision {
  cleanup: boolean;
  reason?: 'bot-alone' | 'bot-removed';
}

/**
 * Decide whether an abandoned-chat cleanup should run.
 *
 * Triggers only on `MemberRemovedFromGroup` system messages. A chat is
 * considered abandoned if either:
 *   - the bot itself is no longer a member (bot was kicked), or
 *   - the bot is the only remaining member (everyone else left).
 */
export function decideCleanup(
  systemMessageType: string | undefined,
  contactsAfterRemoval: number[],
): CleanupDecision {
  if (systemMessageType !== 'MemberRemovedFromGroup') {
    return { cleanup: false };
  }
  if (!contactsAfterRemoval.includes(CONTACT_SELF)) {
    return { cleanup: true, reason: 'bot-removed' };
  }
  if (contactsAfterRemoval.length === 1 && contactsAfterRemoval[0] === CONTACT_SELF) {
    return { cleanup: true, reason: 'bot-alone' };
  }
  return { cleanup: false };
}
