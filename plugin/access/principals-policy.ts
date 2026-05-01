/**
 * Principal policy layer (v1.3) — high-level queries that combine the
 * principal store with the chat-allowlist cache.
 *
 * Layered above:
 *   - `principals.ts` — pure I/O (load/write/list/remove ContactPrincipal records)
 *   - `chat-allowlist.ts` — in-memory permissioned-chats cache
 *   - `capability-bundles.ts` — role → capability set
 *
 * The split exists to break a circular dependency that the v1.3 slice 2
 * code papered over with `await import(...)`. Both reviewers (Elena
 * architecture review + Oliver codegen-failure review) flagged it. The
 * fix is to move every function that needs BOTH `principals` and
 * `chat-allowlist` here, so neither lower module imports the other.
 *
 * What lives here:
 *   - `chatsFor(p)` — derived from chat-allowlist's owner cache
 *   - `isContactPermissioned(c)` — principal record OR legacy fallback
 *   - `hasAnyPermissionedContact()` — fresh-install vs. some-trust gate
 *   - `getCapabilitiesFor(c)` — resolved capability set
 *   - `backfillFromAllowlist()` — startup migration helper
 */

import { chatsForOwner, hasAnyOwner, isKnownOwner, listPaired } from "./chat-allowlist.js";
import { bundleFor } from "./capability-bundles.js";
import { _setPrincipalsMutateCallback, listContacts, loadContact, writeContact, type Principal } from "./principals.js";

// ── Permissioned-contacts cache (v1.3 review fix — Elena HURT 2) ────────────
//
// `isContactPermissioned` is called on every inbound message via the
// router's isAuthorized predicate (slice 5). Before this cache, every
// call did a sync FS stat + JSON read via loadContact — millisecond-
// scale latency on the hot path.
//
// The cache is a Set<contactId> populated lazily from listContacts on
// first access. Invalidated on every principal write/remove/dir-change
// via the callback registered with principals.ts. Subsequent reads
// rebuild on next access.
//
// `isKnownOwner` is still consulted as a legacy fallback for the brief
// boot window before backfillFromAllowlist runs (matches the v1.2.2
// contract).
let _permissionedContactIds: Set<number> | null = null;

function getPermissionedContactIds(): Set<number> {
  if (_permissionedContactIds === null) {
    _permissionedContactIds = new Set<number>();
    for (const c of listContacts()) _permissionedContactIds.add(c.contactId);
  }
  return _permissionedContactIds;
}

// Register the invalidation callback at module load. principals-policy
// imports principals (above), so principals-policy's module evaluates
// after principals — the callback is set before any principal write.
_setPrincipalsMutateCallback(() => {
  _permissionedContactIds = null;
});

/**
 * Chats this principal currently has access to. Phase 2 derives this
 * from the chat-allowlist (humans only); Phase 3 will use the on-disk
 * principal record directly once agents land.
 */
export function chatsFor(p: Principal): number[] {
  if (p.kind === "human") return chatsForOwner(p.contactId);
  // Agents land in Phase 3 — `principals.chatsFor` will read from
  // `agents/<agentId>.json` then.
  return [];
}

/**
 * Is this contact a trusted principal of the bot?
 *
 * Hot-path predicate — called from the slice-5 multi-user-dispatch
 * gate on every inbound message AND from the per-tool capability gate
 * via `getCapabilitiesFor`. Sync `Set.has` on the in-memory
 * `permissionedContactIds` cache (lazy-rebuilt from `listContacts` on
 * invalidation). Reviewer Elena HURT 2 flagged the pre-fix FS-stat-
 * per-message regression; this cache restores v1.2.2-class latency.
 *
 * Falls back to the legacy `isKnownOwner` chat-allowlist scan for the
 * brief boot window before `backfillFromAllowlist` runs (covers pre-
 * Phase-2 installs that haven't yet backfilled). Same shape as v1.2.2.
 *
 * Used as the auth gate for incoming messages: any chat where a
 * permissioned contact sends a message is auto-paired without
 * ceremony. Per-contact unpair (`removeContact` + chat cleanup) wipes
 * the trust fully, so a fully-unpaired contact reads false here.
 */
export function isContactPermissioned(contactId: number): boolean {
  return getPermissionedContactIds().has(contactId) || isKnownOwner(contactId);
}

/**
 * Is the bot in "fresh-install" mode (no contacts have ever paired)?
 *
 * The principal-aware counterpart to `chat-allowlist.hasAnyOwner()`.
 * Returns true if ANY layer (principal record OR chat-allowlist entry
 * with an owner) shows a paired contact. Auth gates that distinguish
 * "stranger lockout vs fresh-install" must use this — the legacy
 * `hasAnyOwner` reads only the chat-allowlist, so a contact that exists
 * as a principal-only record (Option A's edge case: unpair-via-
 * removeChat-only, or a future tool that creates a principal without
 * chats) would falsely register as "no owners exist" and let a
 * stranger pair through.
 */
export function hasAnyPermissionedContact(): boolean {
  if (hasAnyOwner()) return true;
  // listContacts does one readdir; cheap. Returns the union of chat-
  // allowlist owners and principal records.
  return listContacts().length > 0;
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
 * Intentionally NOT memoized — role changes via `setHumanRole`
 * (slice 6/7) must take effect on the next tool call. The lookup is
 * one stat + one small JSON read; cheap.
 */
export function getCapabilitiesFor(contactId: number): string[] {
  const p = loadContact(contactId);
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
export function backfillFromAllowlist(): number {
  let written = 0;
  for (const dev of listPaired()) {
    if (loadContact(dev.contactId) !== null) continue;
    writeContact({
      kind: "human",
      contactId: dev.contactId,
      firstPairedAt: new Date(dev.pairedAtMs).toISOString(),
    });
    written++;
  }
  return written;
}
