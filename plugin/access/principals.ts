/**
 * Principal records — the on-disk source of truth for "who exists" in
 * the channel.  Phase 2 of the identity/teams migration:
 * `docs/specs/2026-04-20-identity-and-teams-design.md`.
 *
 * Schema:
 *   ~/.claude/channels/deltachat/principals/
 *   └── humans/<contactId>.json
 *         { kind: "human", contactId, displayName?, firstPairedAt }
 *
 * Phase 2 scope: we WRITE these records on pair (so the store starts
 * populating). Reads land in Phase 3 when the compatibility shim
 * routes `isAllowed` through here. Until then, `chat-allowlist.ts` is
 * still the auth gate.
 *
 * `agents/<agentId>.json` arrives in Phase 3 — see the design doc.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { chatsForOwner, hasAnyOwner, isKnownOwner, listPaired } from "./chat-allowlist.js";
import { bundleFor } from "./capability-bundles.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type PrincipalKind = "human" | "agent";

export interface HumanPrincipal {
  kind: "human";
  contactId: number;
  displayName?: string;
  /** ISO timestamp of the *first* successful pair for this contact. */
  firstPairedAt: string;
  /**
   * Role assigned at pairing time (or by the subscriber via the role
   * dropdown). Maps to a capability bundle. v1.3 slice 1 only fills this
   * field on read for legacy records (defaults to `subscriber`,
   * preserving binary-trust behavior on upgrade); the pairing-time role
   * picker that asks the subscriber to classify each new contact lands
   * in slice 6.
   */
  role?: string;
  /**
   * Resolved capability set. May be the role's bundle or an explicit
   * override. v1.3 slice 1 fills this on read for legacy records:
   *   - role + capabilities both missing → `["*"]` (subscriber default)
   *   - role set, capabilities missing → `bundleFor(role)`
   *   - capabilities set → use as-is
   * Empty set is denied-everywhere; the dispatcher gate is fail-closed,
   * and `getCapabilitiesFor` returns `[]` for unknown contacts.
   */
  capabilities?: string[];
}

export interface AgentPrincipal {
  kind: "agent";
  agentId: string;
  chatmailAddress?: string;
  displayName: string;
  teamId: string | null;
  dispatcherBinding: "main" | string;
}

export type Principal = HumanPrincipal | AgentPrincipal;

// ── Directory plumbing ───────────────────────────────────────────────────────

let _principalsDir = process.env.DC_TEST_PRINCIPALS_DIR ?? join(
  homedir(),
  ".claude",
  "channels",
  "deltachat",
  "principals",
);

/** Current principals directory path. */
export function getPrincipalsDir(): string { return _principalsDir }

/** Override the principals directory (for testing). */
export function setPrincipalsDir(dir: string): void { _principalsDir = dir }

function humanPath(contactId: number): string {
  return join(_principalsDir, "humans", `${contactId}.json`);
}

// ── Atomic JSON write ────────────────────────────────────────────────────────

function atomicWriteJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
  // Defensive: rename preserves the source mode, but if `path` already
  // existed with a different mode an older Node could surprise us.
  // Explicit chmod is idempotent and removes ambiguity.
  try { chmodSync(path, 0o600); } catch { /* best-effort */ }
}

// ── Human principals ─────────────────────────────────────────────────────────

/** Read a human principal by contact id, or null if missing/corrupt. */
export function loadHuman(contactId: number): HumanPrincipal | null {
  const path = humanPath(contactId);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<HumanPrincipal>;
    if (parsed.kind !== "human" || typeof parsed.contactId !== "number" || typeof parsed.firstPairedAt !== "string") {
      return null;
    }
    const role = typeof parsed.role === "string" ? parsed.role : "subscriber";
    const capabilities = Array.isArray(parsed.capabilities)
      ? parsed.capabilities.filter((c): c is string => typeof c === "string")
      : (typeof parsed.role === "string" ? [...bundleFor(parsed.role)] : ["*"]);
    return {
      kind: "human",
      contactId: parsed.contactId,
      displayName: parsed.displayName,
      firstPairedAt: parsed.firstPairedAt,
      role,
      capabilities,
    };
  } catch {
    return null;
  }
}

/** Atomically persist a human principal record. */
export function writeHuman(p: HumanPrincipal): void {
  atomicWriteJson(humanPath(p.contactId), p);
}

/**
 * List all human principals on disk, sorted by `firstPairedAt` (oldest first)
 * with `contactId` as tiebreaker.
 */
export function listHumans(): HumanPrincipal[] {
  const dir = join(_principalsDir, "humans");
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: HumanPrincipal[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const id = parseInt(name.slice(0, -5), 10);
    if (Number.isNaN(id)) continue;
    const p = loadHuman(id);
    if (p) out.push(p);
  }
  out.sort((a, b) => a.firstPairedAt.localeCompare(b.firstPairedAt) || a.contactId - b.contactId);
  return out;
}

/**
 * Remove a human principal record. Silently ignores missing files.
 *
 * Other I/O errors (EACCES on a read-only FS, etc.) are surfaced via
 * stderr — the caller path is per-contact unpair, where a silent
 * failure would mean the user sees a "deleted" toast but the
 * principal stays put and `isContactPermissioned` keeps returning true.
 * Stderr lets the dispatcher's debug.log capture it.
 */
export function removeHuman(contactId: number): void {
  try {
    unlinkSync(humanPath(contactId));
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") return; // expected — no record to remove
    // Real failure (EACCES, EBUSY, EROFS, etc.) — log so the unpair
    // operator notices the principal didn't actually go away.
    console.error(`principals.removeHuman(${contactId}) failed:`, err);
  }
}

/**
 * Record a successful pair for `contactId`.  Idempotent — if a record
 * already exists, `firstPairedAt` is preserved and only `displayName`
 * is updated (when supplied).
 *
 * Hooked into `access.completePairing()` so every pair writes a record.
 */
export function recordHumanPair(contactId: number, displayName?: string): HumanPrincipal {
  const existing = loadHuman(contactId);
  const principal: HumanPrincipal = {
    kind: "human",
    contactId,
    displayName: displayName ?? existing?.displayName,
    firstPairedAt: existing?.firstPairedAt ?? new Date().toISOString(),
  };
  writeHuman(principal);
  return principal;
}

/**
 * Backfill principal records for every unique owner currently in the
 * chat-allowlist.  Run once on dispatcher startup so legacy installs
 * pick up the new store without re-pairing.
 *
 * Idempotent: never overwrites an existing record (preserves the
 * authoritative `firstPairedAt`).  `firstPairedAt` for backfilled
 * records is taken from the earliest `approved/<chatId>` file mtime
 * for that owner, which is the closest proxy to the original pair
 * time we have.
 *
 * Returns the number of records newly written.
 */
export function backfillFromAllowlist(): number {
  let written = 0;
  for (const dev of listPaired()) {
    if (loadHuman(dev.contactId) !== null) continue;
    writeHuman({
      kind: "human",
      contactId: dev.contactId,
      firstPairedAt: new Date(dev.pairedAtMs).toISOString(),
    });
    written++;
  }
  return written;
}

// ── Derived queries ──────────────────────────────────────────────────────────

/**
 * Chats this principal currently has access to.  Phase 2 derives this
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
 * Source of truth as of v1.2.2 (#66 Option A): the on-disk human
 * principal record. Falls back to the legacy `isKnownOwner` chat-
 * allowlist scan to cover pre-Phase-2 installs that haven't yet
 * backfilled. `backfillFromAllowlist()` runs at dispatcher startup
 * (server.ts main()) before message routing begins, so the legacy
 * fallback only matters during the boot window or for state that
 * predates Phase 2 entirely.
 *
 * Used as the auth gate for incoming messages: any chat where a
 * permissioned contact sends a message is auto-paired without
 * ceremony. Per-contact unpair (`removeHuman` + chat cleanup) wipes
 * the trust fully, so a fully-unpaired contact reads false here.
 */
export function isContactPermissioned(contactId: number): boolean {
  return loadHuman(contactId) !== null || isKnownOwner(contactId);
}

/**
 * Is the bot in "fresh-install" mode (no contacts have ever paired)?
 *
 * The principal-aware counterpart to `chat-allowlist.hasAnyOwner()`.
 * Returns true if ANY layer (principal record OR chat-allowlist
 * entry with an owner) shows a paired contact. Auth gates that
 * gate on "stranger lockout vs fresh-install" must use this — the
 * legacy `hasAnyOwner` reads only the chat-allowlist, so a contact
 * that exists as a principal-only record (Option A's new edge case:
 * unpair-via-removeChat-only, or a future tool that creates a
 * principal without chats) would falsely register as "no owners
 * exist" and let a stranger pair through.
 */
export function hasAnyPermissionedContact(): boolean {
  if (hasAnyOwner()) return true;
  // listHumans does one readdir; cheap. Returns the union of chat-
  // allowlist owners and principal records.
  return listHumans().length > 0;
}

/**
 * Resolved capability set for a contact (v1.3 slice 1).
 *
 * Resolution order:
 *   1. Unknown contact (no principal) → `[]` (denied-everywhere; the
 *      dispatcher gate is fail-closed).
 *   2. Principal has explicit `capabilities` → use it.
 *   3. Principal has `role` only → expand the role's bundle.
 *   4. Neither → `["*"]` (legacy backfill safety; pre-v1.3 records are
 *      treated as `subscriber`).
 *
 * Intentionally NOT memoized — role changes via `setHumanRole` (slice 6/7)
 * must take effect on the next tool call. The lookup is one stat + one
 * small JSON read; cheap.
 */
export function getCapabilitiesFor(contactId: number): string[] {
  const p = loadHuman(contactId);
  if (!p) return [];
  if (Array.isArray(p.capabilities) && p.capabilities.length > 0) return [...p.capabilities];
  if (typeof p.role === "string" && p.role.length > 0) return [...bundleFor(p.role)];
  return ["*"];
}
