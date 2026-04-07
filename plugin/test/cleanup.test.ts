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

  // ── ChatModified trigger (locally-generated leave events) ────────────────

  test('ChatModified triggers bot-alone when only self remains', () => {
    const d = decideCleanup('ChatModified', [CONTACT_SELF]);
    expect(d.cleanup).toBe(true);
    expect(d.reason).toBe('bot-alone');
  });

  test('ChatModified triggers bot-removed when self was removed locally', () => {
    // Not actually how ChatModified arrives, but covers the symmetry.
    const d = decideCleanup('ChatModified', [2, 3]);
    expect(d.cleanup).toBe(true);
    expect(d.reason).toBe('bot-removed');
  });

  test('ChatModified does not trigger with a populated group', () => {
    const d = decideCleanup('ChatModified', [CONTACT_SELF, 2, 3]);
    expect(d.cleanup).toBe(false);
  });

  test('unrelated event types do not trigger cleanup', () => {
    expect(decideCleanup('ChatlistChanged', [CONTACT_SELF]).cleanup).toBe(false);
    expect(decideCleanup('MsgsChanged', []).cleanup).toBe(false);
  });
});
