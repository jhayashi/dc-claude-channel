/**
 * Contact records — trust annotations on entries in the bot's DC contact
 * book. One file per contact, keyed by dc-core contactId.
 *
 * A `Contact` here represents any DC contact in the bot's address
 * book — human or third-party bot. The two are indistinguishable to
 * the auth model; the `role` field (subscriber / family-member /
 * trusted-agent / untrusted-agent / guest) carries the trust-tier
 * distinction.
 *
 * Phase 3 of v1.3 slice 7 will move these records under
 * `agents/<agentId>/contacts/<contactId>.json` so each agent owns its
 * own contact-book annotations (forward-compat for v1.4's per-agent
 * chatmail accounts). Today, until that phase lands, they still live
 * at the legacy single-bucket path:
 *
 *   ~/.claude/channels/deltachat/principals/humans/<contactId>.json
 *
 * `kind: "human"` on disk is preserved for backwards compat with v1.2.2
 * records; the auth model never reads it.
 *
 * `AgentPrincipal` (separate type — kept for v1.4) is the
 * managed-agent concept: a bot the dispatcher provisions chatmail for,
 * with an `agentId` distinct from any `contactId`. Distinct from
 * "third-party bot in your address book" — those are Contacts with
 * role `trusted-agent` / `untrusted-agent`.
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { bundleFor } from "./capability-bundles.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type ContactKind = "human" | "agent";

export interface Contact {
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

// `Principal` union dropped in v1.3 slice 7 — the data is just
// contact-book annotations + a parallel managed-agent concept. Use
// `Contact` directly. Re-introduce the union if/when v1.4 needs it.

/** Singleton agent id for v1.3. v1.4 callers pass their own agent id. */
export const DEFAULT_AGENT_ID = "claude-code";

// ── Directory plumbing ───────────────────────────────────────────────────────

// v1.4: contact records live in a `<name>.dc/contacts/` sidecar dir
// alongside the agent's .md definition under ~/.claude/agents/. The
// sidecar is opaque to agents.ts and to CC's agent scanner (which only
// looks at *.md files at the top level).
// _agentsDir points to the agents root; contactPath() derives the per-record
// path from it. Kept separate from _principalsDir (the legacy source used only
// by the migration function).
let _agentsDir = process.env.DC_TEST_CONTACTS_DIR ?? join(
  homedir(),
  ".claude",
  "agents",
);

/** Override the agents directory for contacts (for testing). */
export function setContactsAgentsDir(dir: string): void {
  _agentsDir = dir;
  _onMutate();
}

// Legacy principals dir — used only by migrateContactsToAgentScoped() as the
// migration source. Not involved in normal read/write operations.
let _principalsDir = process.env.DC_TEST_PRINCIPALS_DIR ?? join(
  homedir(),
  ".claude",
  "channels",
  "deltachat",
  "principals",
);

/** Current principals directory path (legacy; migration source only). */
export function getPrincipalsDir(): string { return _principalsDir }

/** Override the legacy principals directory (migration source; for testing). */
export function setPrincipalsDir(dir: string): void {
  _principalsDir = dir;
  _onMutate();
}

/**
 * Cache invalidation hook. contact-policy registers itself here at
 * module load so it can drop its `permissionedContactIds` cache on
 * every write / remove / dir change. Stays a function-pointer (rather
 * than a static import from contact-policy) to avoid the
 * contacts ↔ contact-policy cycle the slice-2 review broke.
 */
let _onMutate: () => void = () => { /* no-op until policy registers */ };
export function _setContactsMutateCallback(cb: () => void): void { _onMutate = cb; }

function contactPath(agentName: string, contactId: number): string {
  return join(_agentsDir, `${agentName}.dc`, "contacts", `${contactId}.json`);
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

/**
 * Read a human principal by contact id.
 *
 * Returns null when the record is genuinely absent (ENOENT). For other
 * I/O errors (EACCES, EROFS, EBUSY, malformed JSON, schema-mismatch),
 * THROWS so the caller's capability gate distinguishes "we said no"
 * (capability_deny — contact has no record) from "we couldn't decide"
 * (capability_lookup_error — record exists but we can't read it). Per
 * security review T4. Reviewer Oliver P2 #1 flagged that the prior
 * blanket-catch made T4's distinction dead code.
 */
export function loadContact(agentId: string, contactId: number): Contact | null {
  const path = contactPath(agentId, contactId);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") return null;
    // Real failure — propagate so the capability gate logs
    // capability_lookup_error rather than collapsing to a misleading
    // capability_deny.
    throw err;
  }
  const parsed = JSON.parse(raw) as Partial<Contact>;
  if (parsed.kind !== "human" || typeof parsed.contactId !== "number" || typeof parsed.firstPairedAt !== "string") {
    // Schema mismatch — treat as corrupt rather than absent. Throwing
    // routes this through the gate's lookup-error path, surfacing the
    // bad record to the operator instead of silently denying.
    throw new Error(`contacts.loadContact: schema mismatch in ${path} (agent=${agentId})`);
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
}

/** Atomically persist a human principal record. */
export function writeContact(agentId: string, p: Contact): void {
  atomicWriteJson(contactPath(agentId, p.contactId), p);
  _onMutate();
}

/**
 * List all human principals on disk, sorted by `firstPairedAt` (oldest
 * first) with `contactId` as tiebreaker.
 *
 * Skips records that fail to load — `loadContact` throws for corrupt /
 * unreadable records (so the capability gate can log
 * `capability_lookup_error` for one-off lookups), but the listing path
 * is used at startup and shouldn't take down the dispatcher because of
 * a single bad file. Errors are logged to stderr for operator visibility.
 */
export function listContacts(agentName: string): Contact[] {
  const dir = join(_agentsDir, `${agentName}.dc`, "contacts");
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: Contact[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const id = parseInt(name.slice(0, -5), 10);
    if (Number.isNaN(id)) continue;
    try {
      const p = loadContact(agentName, id);
      if (p) out.push(p);
    } catch (err) {
      console.error(`contacts.listContacts: skipping ${name} — ${(err as Error).message}`);
    }
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
export function removeContact(agentId: string, contactId: number): void {
  try {
    unlinkSync(contactPath(agentId, contactId));
    _onMutate();
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") return; // expected — no record to remove
    // Real failure (EACCES, EBUSY, EROFS, etc.) — log so the unpair
    // operator notices the principal didn't actually go away.
    console.error(`contacts.removeContact(${agentId}, ${contactId}) failed:`, err);
  }
}

/**
 * Record a successful pair for `contactId`. Idempotent for `firstPairedAt`
 * (preserved across re-pairs) and `displayName` (updated when supplied).
 *
 * **Role: terminal pairs are always subscribers (v1.3 slice 6).** Running
 * `/deltachat:setup` from the local terminal Claude Code session IS the
 * trust signal — anyone you coordinate a QR/code pair with through that
 * flow gets full subscriber capabilities. Re-pair always elevates back
 * to subscriber even if the contact was downgraded via the XDC picker
 * (subscriber can downgrade them again afterwards if it was a mistake).
 *
 * Hooked into `access.completePairing()` so every pair writes the record.
 *
 * Safe against corrupt existing records — loadContact may throw on a
 * malformed JSON / schema-mismatch principal file (slice-3-5 review fix);
 * we treat that as "no existing record" so re-pair recovers the contact.
 */
export function recordContactPair(agentId: string, contactId: number, displayName?: string): Contact {
  let existing: Contact | null = null;
  try {
    existing = loadContact(agentId, contactId);
  } catch (err) {
    console.error(`contacts.recordContactPair(${agentId}, ${contactId}): corrupt existing record, overwriting:`, err);
  }
  const principal: Contact = {
    kind: "human",
    contactId,
    displayName: displayName ?? existing?.displayName,
    firstPairedAt: existing?.firstPairedAt ?? new Date().toISOString(),
    role: "subscriber",
    capabilities: ["*"],
  };
  writeContact(agentId, principal);
  return principal;
}

/**
 * Upsert a contact's role + capabilities (v1.3 slice 6).
 *
 * Used by the XDC role picker (slice 7) to permission contacts who landed
 * in a paired chat via group-add — they have no principal yet because the
 * group-add path doesn't go through `recordContactPair`. This function
 * creates the principal on first call OR mutates an existing one.
 *
 * `capabilities` is set to `bundleFor(role)` so the explicit-array
 * deny-by-empty path doesn't fire by accident; advanced operators who
 * want a custom override can edit the JSON directly.
 *
 * Calls `_onMutate()` so the contact-policy permissioned-contacts
 * cache (slice-3-5 review fix #3) invalidates and the next
 * isContactPermissioned read sees the new contact.
 */
export function setContactRole(agentId: string, contactId: number, role: string, displayName?: string): Contact {
  let existing: Contact | null = null;
  try {
    existing = loadContact(agentId, contactId);
  } catch (err) {
    console.error(`contacts.setContactRole(${agentId}, ${contactId}): corrupt existing record, overwriting:`, err);
  }
  const principal: Contact = {
    kind: "human",
    contactId,
    displayName: displayName ?? existing?.displayName,
    firstPairedAt: existing?.firstPairedAt ?? new Date().toISOString(),
    role,
    capabilities: [...bundleFor(role)],
  };
  writeContact(agentId, principal);
  return principal;
}

/**
 * Migrate contact records from the legacy `principals/humans/` layout to
 * the v1.3 agent-scoped `agents/claude-code/contacts/` layout.
 *
 * Per-file idempotent: a record is copied iff it is missing at the
 * target. This handles the half-migrated case where the target dir
 * already exists (e.g., new contacts written via `recordContactPair` or
 * test leakage) but some legacy records were never carried over —
 * gating purely on target-dir existence would silently strand them.
 *
 * After every legacy record is present at the target, renames
 * `principals/` to `principals.legacy/` so subsequent startups short-
 * circuit. Skips the rename if any source records are still missing at
 * the target (so the next boot retries).
 *
 * Returns the number of records newly copied (0 on a no-op run).
 */
export function migrateContactsToAgentScoped(): number {
  const sourceDir = join(_principalsDir, "humans");
  if (!existsSync(sourceDir)) return 0;

  const targetDir = join(_agentsDir, "claude-code.dc", "contacts");
  let entries: string[];
  try {
    entries = readdirSync(sourceDir);
  } catch (err) {
    console.error("contacts.migrateContactsToAgentScoped: cannot read source dir:", err);
    return 0;
  }

  let count = 0;
  let allPresent = true;
  try {
    mkdirSync(targetDir, { recursive: true });
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const target = join(targetDir, entry);
      if (existsSync(target)) continue;
      copyFileSync(join(sourceDir, entry), target);
      count++;
    }
    // Verify every source record has a target counterpart before retiring source.
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      if (!existsSync(join(targetDir, entry))) { allPresent = false; break; }
    }
  } catch (err) {
    console.error("contacts.migrateContactsToAgentScoped: error during migration:", err);
    return count;
  }

  if (allPresent) {
    try {
      const legacyPath = `${_principalsDir}.legacy`;
      if (!existsSync(legacyPath)) renameSync(_principalsDir, legacyPath);
    } catch (err) {
      console.error("contacts.migrateContactsToAgentScoped: failed to rename legacy dir:", err);
    }
  }

  return count;
}

// Derived queries (`chatsFor`, `isContactPermissioned`,
// `hasAnyPermissionedContact`, `getCapabilitiesFor`,
// `backfillFromAllowlist`) live in `./contact-policy.ts` — moved
// in v1.3 to break a chat-allowlist ↔ principals circular dependency
// flagged by reviewers Elena + Oliver. The barrel `./index.ts` re-
// exports them, so `access.X` callers see no API change.
