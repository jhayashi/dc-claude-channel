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

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { chatsForOwner, listPaired } from "./chat-allowlist.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type PrincipalKind = "human" | "agent";

export interface HumanPrincipal {
  kind: "human";
  contactId: number;
  displayName?: string;
  /** ISO timestamp of the *first* successful pair for this contact. */
  firstPairedAt: string;
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
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
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
    return {
      kind: "human",
      contactId: parsed.contactId,
      displayName: parsed.displayName,
      firstPairedAt: parsed.firstPairedAt,
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

/** Remove a human principal record. Silently ignores missing files. */
export function removeHuman(contactId: number): void {
  try {
    unlinkSync(humanPath(contactId));
  } catch {
    // ignore
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
