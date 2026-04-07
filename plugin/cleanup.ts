/**
 * Chat cleanup decision logic.
 *
 * When a chat membership change happens (a member-removal system message, or
 * a ChatModified event from dc-core for locally-generated changes like a
 * self-initiated leave), we decide whether the chat should be cleaned up
 * (deleted + access entry removed + sessions dropped). This module is a
 * pure function to make the decision unit-testable.
 */

/** DC core contact ID for "self". Mirrors the constant in dc-client.ts. */
export const CONTACT_SELF = 1;

/**
 * Triggers that can prompt a cleanup check.
 *
 * - `MemberRemovedFromGroup`: an `IncomingMsg` system message, fired when
 *   someone else removes a member (including the bot) via an incoming email.
 * - `ChatModified`: a dc-core event fired when chat membership changes
 *   locally — e.g. the chat owner leaves the group from their own device.
 *   This event does NOT come through IncomingMsg, which is why we listen for
 *   it separately.
 */
export type CleanupTrigger = 'MemberRemovedFromGroup' | 'ChatModified';

export interface CleanupDecision {
  cleanup: boolean;
  reason?: 'bot-alone' | 'bot-removed';
}

/**
 * Decide whether an abandoned-chat cleanup should run.
 *
 * A chat is considered abandoned if either:
 *   - the bot itself is no longer a member (bot was kicked), or
 *   - the bot is the only remaining member (everyone else left).
 *
 * Any unknown trigger returns no-cleanup so we don't accidentally GC on
 * unrelated events.
 */
export function decideCleanup(
  trigger: string | undefined,
  contactsAfterRemoval: number[],
): CleanupDecision {
  if (trigger !== 'MemberRemovedFromGroup' && trigger !== 'ChatModified') {
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
