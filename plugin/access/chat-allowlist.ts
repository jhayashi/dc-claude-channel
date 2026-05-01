/**
 * In-memory allowlist for Delta Chat channel access (v1.3 slice 2).
 *
 * **Source of truth: principal records + chat membership.** This module
 * holds a sync cache derived from those two inputs. Hot-path readers
 * (the auth gate before every DC tool call) get a single Set.has() —
 * no FS round-trip, no dc-core RPC.
 *
 * Cache state:
 *   - `permissionedChats: Set<chatId>` — chats with at least one
 *     non-bot member who has a principal record
 *   - `chatOwnerCache: Map<chatId, contactId>` — first permissioned
 *     member encountered when scanning the chat (used by audit logging
 *     and the trust filter as the chat's "responsible contact")
 *
 * Population:
 *   - `populateAllowlistFromMembership(getChats, getChatContacts)` —
 *     called once at dispatcher startup
 *   - `refreshAllowlistForChat(chatId, getChatContacts)` — called from
 *     the `ChatModified` event handler when membership changes
 *   - `addChat(chatId, contactId)` — called from the pair-completion
 *     path and chat-creation flows when we know a contact just landed
 *     in the chat (avoids waiting for the next ChatModified)
 *
 * Migration from v1.2.2:
 *   - The legacy `approved/<chatId>` files are walked at startup as a
 *     fallback (in case the chat-membership population missed something
 *     transient), then the directory is renamed to `approved.legacy/`
 *     by `retireApprovedDir()`. v1.4 drops the legacy dir entirely.
 *
 * Pairing flow state (arm window + pending codes, in-memory only)
 * lives in `./pairing.ts` — unchanged.
 */

import { existsSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadContact } from "./principals.js";

// ── Module state ─────────────────────────────────────────────────────────────

let _approvedDir = process.env.DC_TEST_APPROVED_DIR ?? join(
  homedir(),
  ".claude",
  "channels",
  "deltachat",
  "approved",
);

const permissionedChats = new Set<number>();
const chatOwnerCache = new Map<number, number>();
const pairedAtMsCache = new Map<number, number>();

/** Current legacy `approved/` directory path (only read at startup). */
export function getApprovedDir(): string { return _approvedDir }

/**
 * Override the legacy directory (testing). Also clears the in-memory
 * caches — tests rely on this for isolation between runs.
 */
export function setApprovedDir(dir: string): void {
  _approvedDir = dir;
  permissionedChats.clear();
  chatOwnerCache.clear();
  pairedAtMsCache.clear();
}

// ── Read API (sync, hot path) ────────────────────────────────────────────────

/** All currently permissioned chats. */
export function allowedChats(): number[] {
  return [...permissionedChats].sort((a, b) => a - b);
}

/** Is this chat permissioned (has at least one principal in its membership)? */
export function isAllowed(chatId: number): boolean {
  return permissionedChats.has(chatId);
}

/**
 * The first permissioned contact encountered when the chat was scanned.
 * Used by audit logs as the "responsible contact" for the chat. Returns
 * null for chats not in the cache.
 */
export function firstPermissionedContact(chatId: number): number | null {
  return chatOwnerCache.get(chatId) ?? null;
}

/**
 * @deprecated v1.3.0 — renamed to `firstPermissionedContact`. Kept as
 * an alias for one release; remove in v1.4.
 */
export function getOwner(chatId: number): number | null {
  return firstPermissionedContact(chatId);
}

// ── Write API (cache mutations only; no FS writes) ───────────────────────────

/**
 * Mark a chat as permissioned, with `contactId` as the responsible
 * contact. Idempotent. The first call wins for the responsible-contact
 * record (matching pre-v1.3 semantics where the file's content was
 * stable across re-pairs).
 */
export function addChat(chatId: number, ownerContactId?: number): void {
  permissionedChats.add(chatId);
  if (ownerContactId && !chatOwnerCache.has(chatId)) {
    chatOwnerCache.set(chatId, ownerContactId);
    pairedAtMsCache.set(chatId, Date.now());
  }
}

/** Remove a chat from the allowlist. Silently ignores unknown chats. */
export function removeChat(chatId: number): void {
  permissionedChats.delete(chatId);
  chatOwnerCache.delete(chatId);
  pairedAtMsCache.delete(chatId);
}

// ── Owner-derived helpers ────────────────────────────────────────────────────

/**
 * Check if a contact ID is the responsible contact for any allowed chat.
 *
 * @deprecated v1.2.2 (#66 Option A) — prefer `isContactPermissioned`
 * from `./principals.ts`. Kept as a fallback path inside
 * `isContactPermissioned` itself; no other production caller.
 */
export function isKnownOwner(contactId: number): boolean {
  for (const id of chatOwnerCache.values()) {
    if (id === contactId) return true;
  }
  return false;
}

/** True if at least one allowed chat has a recorded responsible contact. */
export function hasAnyOwner(): boolean {
  return chatOwnerCache.size > 0;
}

/** A paired device — a contact that's the responsible contact for at least one chat. */
export interface PairedDevice {
  contactId: number;
  /** Chats this contact owns, sorted ascending. */
  chatIds: number[];
  /** Earliest pair timestamp across owned chats (ms since epoch). */
  pairedAtMs: number;
}

/**
 * List paired devices (unique responsible contacts) with their chats and
 * the earliest pair timestamp. Chats with no responsible contact are
 * skipped.
 */
export function listPaired(): PairedDevice[] {
  const map = new Map<number, { chatIds: number[]; pairedAtMs: number }>();
  for (const [chatId, contactId] of chatOwnerCache) {
    const ms = pairedAtMsCache.get(chatId) ?? Date.now();
    const entry = map.get(contactId);
    if (entry) {
      entry.chatIds.push(chatId);
      if (ms < entry.pairedAtMs) entry.pairedAtMs = ms;
    } else {
      map.set(contactId, { chatIds: [chatId], pairedAtMs: ms });
    }
  }
  const out: PairedDevice[] = [];
  for (const [contactId, v] of map) {
    out.push({
      contactId,
      chatIds: v.chatIds.sort((a, b) => a - b),
      pairedAtMs: v.pairedAtMs,
    });
  }
  out.sort((a, b) => a.pairedAtMs - b.pairedAtMs || a.contactId - b.contactId);
  return out;
}

/** Chats where `contactId` is the responsible contact. */
export function chatsForOwner(contactId: number): number[] {
  const out: number[] = [];
  for (const [chatId, ownerId] of chatOwnerCache) {
    if (ownerId === contactId) out.push(chatId);
  }
  return out.sort((a, b) => a - b);
}

// ── Population (called from server.ts startup + ChatModified handler) ────────

/**
 * Walk every chat the dispatcher knows about; for each, mark it
 * permissioned iff at least one non-bot contact has a principal record.
 *
 * `CONTACT_SELF` (the bot's own contact id, always 1 in dc-core) is
 * skipped when scanning for principals. Without that skip, the bot's
 * own self-message-count would falsely permission an empty chat.
 *
 * This is the v1.3 source-of-truth boot sequence: principals + dc-core
 * membership define `isAllowed` rather than the legacy `approved/<chatId>`
 * files. Called once after `backfillFromAllowlist`.
 */
export async function populateAllowlistFromMembership(
  getChats: () => Promise<number[]>,
  getChatContacts: (chatId: number) => Promise<number[]>,
): Promise<void> {
  const chats = await getChats();
  for (const chatId of chats) {
    const contacts = await getChatContacts(chatId);
    let firstPermissioned: number | null = null;
    for (const contactId of contacts) {
      if (contactId === 1) continue; // CONTACT_SELF
      // Direct principal lookup — populate runs after backfill, so any
      // contact in the legacy allowlist now has a principal record.
      // The `isContactPermissioned` policy (with its legacy
      // `isKnownOwner` fallback) lives in principals-policy and isn't
      // needed here; using it would re-introduce the chat-allowlist ↔
      // principals dependency cycle this split was designed to remove.
      if (loadContact(contactId) !== null) {
        firstPermissioned = contactId;
        break;
      }
    }
    if (firstPermissioned !== null) {
      permissionedChats.add(chatId);
      // Don't clobber an existing owner recorded earlier (e.g., from
      // legacy approved/<chatId> seeding). First-seeder wins.
      if (!chatOwnerCache.has(chatId)) {
        chatOwnerCache.set(chatId, firstPermissioned);
      }
    }
  }
}

/**
 * Refresh the cache for one chat. Called from the `ChatModified` event
 * handler when membership changes (contact joined/left/etc.).
 */
export async function refreshAllowlistForChat(
  chatId: number,
  getChatContacts: (chatId: number) => Promise<number[]>,
): Promise<void> {
  const contacts = await getChatContacts(chatId);
  let firstPermissioned: number | null = null;
  for (const contactId of contacts) {
    if (contactId === 1) continue;
    if (loadContact(contactId) !== null) {
      firstPermissioned = contactId;
      break;
    }
  }
  if (firstPermissioned !== null) {
    permissionedChats.add(chatId);
    chatOwnerCache.set(chatId, firstPermissioned);
  } else {
    permissionedChats.delete(chatId);
    chatOwnerCache.delete(chatId);
    pairedAtMsCache.delete(chatId);
  }
}

// ── Legacy `approved/` directory migration ───────────────────────────────────

/**
 * Seed the cache from the legacy `approved/<chatId>` directory at
 * startup. Used as a transitional fallback before
 * `populateAllowlistFromMembership` runs — covers the gap where a chat
 * is approved on disk but the dc-core membership query hasn't returned
 * it yet (e.g., a brand new chat in mid-pairing).
 *
 * Each file's content is the responsible contact's id (numeric string),
 * or empty for legacy pre-owner files. Empty files seed the chat as
 * allowed but with no owner — matching v1.2.2 semantics.
 */
export function seedFromLegacyDir(): void {
  let entries: string[];
  try {
    entries = readdirSync(_approvedDir);
  } catch {
    return; // dir missing — nothing to seed
  }
  for (const name of entries) {
    const chatId = parseInt(name, 10);
    if (Number.isNaN(chatId)) continue;
    permissionedChats.add(chatId);
    const path = join(_approvedDir, name);
    let content = "";
    try { content = readFileSync(path, "utf-8").trim(); } catch { /* ignore */ }
    if (content) {
      const ownerId = parseInt(content, 10);
      if (!Number.isNaN(ownerId) && !chatOwnerCache.has(chatId)) {
        chatOwnerCache.set(chatId, ownerId);
      }
    }
    try {
      pairedAtMsCache.set(chatId, statSync(path).mtimeMs);
    } catch { /* keep current fallback */ }
  }
}

/**
 * After the in-memory cache is populated from principals + membership,
 * rename `approved/` → `approved.legacy/`. Idempotent. Skips the rename
 * if any `approved/<chatId>` file is not backed by a current cache entry
 * (integrity check; preserves orphans for operator review).
 *
 * Drops in v1.4. The legacy dir is kept for one release as a safety net.
 */
export function retireApprovedDir(): void {
  let entries: string[];
  try {
    entries = readdirSync(_approvedDir);
  } catch {
    return;
  }
  const orphans: string[] = [];
  for (const name of entries) {
    const chatId = parseInt(name, 10);
    if (Number.isNaN(chatId)) continue;
    if (!permissionedChats.has(chatId)) {
      orphans.push(name);
    }
  }
  if (orphans.length > 0) {
    console.error(
      `v1.3 migration: ${orphans.length} approved/ entr${orphans.length === 1 ? "y" : "ies"} not backed by principals — leaving approved/ in place. Orphans: ${orphans.join(", ")}`,
    );
    return;
  }
  const legacy = `${_approvedDir}.legacy`;
  if (existsSync(legacy)) return; // already retired this session
  try {
    renameSync(_approvedDir, legacy);
  } catch (e) {
    console.error(`v1.3 migration: rename approved/ → approved.legacy/ failed: ${(e as Error).message}`);
  }
}
