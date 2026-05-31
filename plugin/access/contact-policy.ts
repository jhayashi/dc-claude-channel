/**
 * Contact policy layer (v1.3) — high-level queries that combine the
 * contact store with the chat-allowlist cache.
 *
 * Layered above:
 *   - `contacts.ts` — pure I/O on Contact records (load/write/list/remove)
 *   - `chat-allowlist.ts` — in-memory chats-with-permissioned-member cache
 *   - `capability-bundles.ts` — role → capability set
 *
 * The split exists to break a circular dependency that the v1.3 slice 2
 * code papered over with `await import(...)`. Both reviewers (Elena
 * architecture review + Oliver codegen-failure review) flagged it. The
 * fix is to move every function that needs BOTH `contacts` and
 * `chat-allowlist` here, so neither lower module imports the other.
 *
 * What lives here:
 *   - `chatsFor(c)` — chats this contact has access to
 *   - `isContactPermissioned(c)` — contact record exists OR legacy fallback
 *   - `hasAnyPermissionedContact()` — fresh-install vs. some-trust gate
 *   - `getCapabilitiesFor(c)` — resolved capability set
 *   - `backfillFromAllowlist()` — startup migration helper
 */

import { chatsForOwner, hasAnyOwner, isKnownOwner, listPaired } from "./chat-allowlist.js";
import { bundleFor } from "./capability-bundles.js";
import { _setContactsMutateCallback, listContacts, loadContact, writeContact, type Contact } from "./contacts.js";

// ── Permissioned-contacts cache (v1.3 review fix — Elena HURT 2) ────────────
//
// `isContactPermissioned` is called on every inbound message via the
// router's isAuthorized predicate (slice 5). Before this cache, every
// call did a sync FS stat + JSON read via loadContact — millisecond-
// scale latency on the hot path.
//
// The cache is a Set<contactId> populated lazily from listContacts on
// first access. Invalidated on every contact write/remove/dir-change
// via the callback registered with contacts.ts. Subsequent reads
// rebuild on next access.
//
// `isKnownOwner` is still consulted as a legacy fallback for the brief
// boot window before backfillFromAllowlist runs (matches the v1.2.2
// contract).
const _permissionedContactIds = new Map<string, Set<number>>();

function getPermissionedContactIds(agentId: string): Set<number> {
  let cached = _permissionedContactIds.get(agentId);
  if (cached === undefined) {
    cached = new Set<number>();
    for (const c of listContacts(agentId)) cached.add(c.contactId);
    _permissionedContactIds.set(agentId, cached);
  }
  return cached;
}

// Register the invalidation callback at module load. contact-policy
// imports contacts (above), so contact-policy's module evaluates
// after contacts — the callback is set before any contact write.
_setContactsMutateCallback(() => {
  _permissionedContactIds.clear();
});

/**
 * Chats this contact currently has access to. v1.3 derives this from
 * the chat-allowlist (humans only); v1.4's per-agent-account model
 * will derive it from agent-scoped storage.
 */
export function chatsFor(c: Contact): number[] {
  return chatsForOwner(c.contactId);
}

/**
 * Is this contact a trusted permissioned contact of the bot?
 *
 * Hot-path predicate — called from the slice-5 multi-user-dispatch
 * gate on every inbound message AND from the per-tool capability gate
 * via `getCapabilitiesFor`. Sync `Set.has` on the in-memory
 * `permissionedContactIds` cache (lazy-rebuilt from `listContacts` on
 * invalidation). Reviewer Elena HURT 2 flagged the pre-fix FS-stat-
 * per-message regression; this cache restores v1.2.2-class latency.
 *
 * Falls back to the legacy `isKnownOwner` chat-allowlist scan for the
 * brief boot window before `backfillFromAllowlist` runs (covers pre-v1.3
 * installs that haven't yet backfilled). Same shape as v1.2.2.
 *
 * Used as the auth gate for incoming messages: any chat where a
 * permissioned contact sends a message is auto-paired without
 * ceremony. Per-contact unpair (`removeContact` + chat cleanup) wipes
 * the trust fully, so a fully-unpaired contact reads false here.
 */
export function isContactPermissioned(agentId: string, contactId: number): boolean {
  return getPermissionedContactIds(agentId).has(contactId) || isKnownOwner(contactId);
}

/**
 * Is the bot in "fresh-install" mode (no contacts have ever paired)?
 *
 * The contact-aware counterpart to `chat-allowlist.hasAnyOwner()`.
 * Returns true if ANY layer (contact record OR chat-allowlist entry
 * with an owner) shows a paired contact. Auth gates that distinguish
 * "stranger lockout vs fresh-install" must use this — the legacy
 * `hasAnyOwner` reads only the chat-allowlist, so a contact that exists
 * as a contact-only record (Option A's edge case: unpair-via-
 * removeChat-only, or a future tool that creates a contact record
 * without chats) would falsely register as "no owners exist" and let
 * a stranger pair through.
 */
export function hasAnyPermissionedContact(agentId: string): boolean {
  if (hasAnyOwner()) return true;
  // listContacts does one readdir; cheap. Returns the union of chat-
  // allowlist owners and contact records.
  return listContacts(agentId).length > 0;
}

/**
 * Trust-filter predicate for inbound message content (chat history,
 * attachments). Stricter than `isContactPermissioned`: requires a
 * non-empty capability set, so a `no-permissions` contact (caps = `[]`)
 * has their content redacted from the subagent's view, just like a
 * fully unpaired sender.
 *
 * Why split this from `isContactPermissioned`:
 *   - `isContactPermissioned` answers "does this contact have a record?" —
 *     used by the auth gate that routes messages and runs the per-tool
 *     capability check.
 *   - `isContactTrustedForContent` answers "should the agent see what
 *     this contact wrote?" — the prompt-injection question. A
 *     `no-permissions` contact is paired (record exists) but
 *     untrusted-for-content (caps empty), so the trust filter must
 *     redact them.
 */
export function isContactTrustedForContent(agentId: string, contactId: number): boolean {
  return getCapabilitiesFor(agentId, contactId).length > 0;
}

/**
 * Resolved capability set for a contact (v1.3 slice 1).
 *
 * Resolution order (the empty-array case matters — pre-fix the prior
 * `length > 0` guard let an explicit `capabilities: []` fall through
 * to the role bundle, silently granting whatever the role granted
 * instead of denying everything; reviewer Oliver flagged this):
 *   1. Unknown contact (no principal) → `[]` (denied-everywhere; the
 *      dispatcher gate is fail-closed).
 *   2. Principal has explicit `capabilities` array (including `[]`) →
 *      use it as the authoritative override. Empty array means
 *      denied-everywhere by design.
 *   3. Principal has `role` only (no capabilities key on disk) → expand
 *      the role's bundle.
 *   4. Neither → `["*"]` (legacy backfill safety; pre-v1.3 records
 *      written without role/capabilities are treated as `subscriber`).
 *
 * Not memoized inside this function. The dispatcher resolves the message
 * sender's caps once per message (cached in `_currentDriver`) and re-resolves
 * fresh for a declared `requestor_contact_id`, so a role change via
 * `setContactRole` takes effect on the sender's next message. The lookup is
 * one stat + one small JSON read.
 */
export function getCapabilitiesFor(agentId: string, contactId: number): string[] {
  const p = loadContact(agentId, contactId);
  if (!p) return [];
  if (Array.isArray(p.capabilities)) return [...p.capabilities];
  if (typeof p.role === "string" && p.role.length > 0) return [...bundleFor(p.role)];
  return ["*"];
}

/**
 * Backfill principal records for every unique owner currently in the
 * chat-allowlist. Run once on dispatcher startup so legacy installs
 * pick up the new store without re-pairing.
 *
 * Idempotent: never overwrites an existing record (preserves the
 * authoritative `firstPairedAt`). `firstPairedAt` for backfilled
 * records is taken from the cache's `pairedAtMs` field, which derives
 * from the legacy `approved/<chatId>` file mtime — the closest proxy
 * to the original pair time we have.
 *
 * Returns the number of records newly written.
 */
/**
 * v1.4.9 — "does any of these agents hold a record for this contact?"
 *
 * Replaces the inline IIFE in server.ts's dc_access_unpair where a
 * single corrupt record in any agent's sidecar would throw out of the
 * loop uncaught (loadContact "may throw on corrupt / unreadable
 * record", slice-3-5 review) and break the user's unpair command.
 *
 * Per-agent try/catch isolates the failure: a corrupt record in one
 * sidecar is logged to stderr and skipped, the iteration continues
 * across the rest. Matches the resilience contract of the canonical-
 * seed migration's per-binding handling.
 *
 * Returns true on the first valid record found (short-circuits).
 */
export function hasContactRecordForAnyAgent(
  contactId: number,
  agentIds: Iterable<string>,
): boolean {
  for (const aid of agentIds) {
    try {
      if (loadContact(aid, contactId) !== null) return true;
    } catch (err) {
      console.error(
        `contacts.hasContactRecordForAnyAgent: skipping ${aid}/${contactId} (corrupt record):`,
        err,
      );
      continue;
    }
  }
  return false;
}

export function backfillFromAllowlist(agentId: string): number {
  let written = 0;
  for (const dev of listPaired()) {
    let existing = null;
    try { existing = loadContact(agentId, dev.contactId); } catch (err) {
      console.error(`contacts.backfillFromAllowlist: skipping contact ${dev.contactId} (corrupt record):`, err);
      continue;
    }
    if (existing !== null) continue;
    writeContact(agentId, {
      kind: "human",
      contactId: dev.contactId,
      firstPairedAt: new Date(dev.pairedAtMs).toISOString(),
    });
    written++;
  }
  return written;
}
