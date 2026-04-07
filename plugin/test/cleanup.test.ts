import { describe, test, expect } from 'bun:test';
import { decideCleanup, CONTACT_SELF } from '../cleanup.js';

describe('decideCleanup', () => {
  test('triggers bot-alone when self is the only remaining contact', () => {
    const d = decideCleanup('MemberRemovedFromGroup', [CONTACT_SELF]);
    expect(d.cleanup).toBe(true);
    expect(d.reason).toBe('bot-alone');
  });

  test('triggers bot-removed when self is no longer in the contact list', () => {
    const d = decideCleanup('MemberRemovedFromGroup', [2, 3]);
    expect(d.cleanup).toBe(true);
    expect(d.reason).toBe('bot-removed');
  });

  test('does not trigger when self and another contact remain', () => {
    const d = decideCleanup('MemberRemovedFromGroup', [CONTACT_SELF, 2]);
    expect(d.cleanup).toBe(false);
    expect(d.reason).toBeUndefined();
  });

  test('does not trigger for non-removal system messages', () => {
    const d = decideCleanup('MemberAddedToGroup', [CONTACT_SELF]);
    expect(d.cleanup).toBe(false);
  });

  test('does not trigger for GroupNameChanged', () => {
    const d = decideCleanup('GroupNameChanged', [CONTACT_SELF]);
    expect(d.cleanup).toBe(false);
  });

  test('does not trigger for non-system (undefined) messages', () => {
    const d = decideCleanup(undefined, [CONTACT_SELF]);
    expect(d.cleanup).toBe(false);
  });

  test('triggers bot-removed even on an empty contact list', () => {
    // Edge case: DC reports zero contacts after self is kicked.
    const d = decideCleanup('MemberRemovedFromGroup', []);
    expect(d.cleanup).toBe(true);
    expect(d.reason).toBe('bot-removed');
  });

  test('does not trigger for a fully populated group', () => {
    const d = decideCleanup('MemberRemovedFromGroup', [CONTACT_SELF, 2, 3, 4]);
    expect(d.cleanup).toBe(false);
  });
});
