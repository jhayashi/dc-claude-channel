/**
 * File-based allowlist and pairing flow for Delta Chat channel access control.
 *
 * Approved chat IDs are stored as files under
 * ~/.claude/channels/deltachat/approved/<chatId>.
 * The file contains the owner's contact ID (the person who paired the chat).
 * Legacy empty files (pre-owner tracking) are treated as having no owner.
 *
 * This file is an intermediate shim during the Phase 0 split
 * (docs/specs/2026-04-20-identity-and-teams-design.md §Phase 0). Pairing
 * state has been extracted to `./access/pairing.ts`; the allowlist itself
 * will move to `./access/chat-allowlist.ts` in Step 3.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Re-export the pairing flow (arm window + pending codes) so existing
// `import * as access from './access.js'` callsites keep working.
export {
  armPairing,
  isArmed,
  getArmedUntil,
  getArmedGroupChatId,
  consumeArmedWindow,
  resetArmedState,
  startPairing,
  completePairing,
  isPendingPair,
} from "./access/pairing.js";

let _approvedDir = process.env.DC_TEST_APPROVED_DIR ?? join(
  homedir(),
  ".claude",
  "channels",
  "deltachat",
  "approved",
);

/** Current approved directory path. */
export function getApprovedDir(): string { return _approvedDir }

/** Override the approved directory (for testing). */
export function setApprovedDir(dir: string): void { _approvedDir = dir }

// --- Allowlist functions ---

/** Return all approved chat IDs. */
export function allowedChats(): number[] {
  let entries: string[];
  try {
    entries = readdirSync(_approvedDir);
  } catch {
    return [];
  }
  const ids: number[] = [];
  for (const name of entries) {
    const id = parseInt(name, 10);
    if (!Number.isNaN(id)) {
      ids.push(id);
    }
  }
  return ids;
}

/** Check whether a chat ID is in the allowlist. */
export function isAllowed(chatId: number): boolean {
  return existsSync(join(_approvedDir, String(chatId)));
}

/** Approve a chat ID. Stores the owner's contact ID in the file. */
export function addChat(chatId: number, ownerContactId?: number): void {
  mkdirSync(_approvedDir, { recursive: true });
  writeFileSync(join(_approvedDir, String(chatId)), ownerContactId ? String(ownerContactId) : "");
}

/** Get the owner contact ID for a chat, or null if unknown (legacy or no owner). */
export function getOwner(chatId: number): number | null {
  const path = join(_approvedDir, String(chatId));
  if (!existsSync(path)) return null;
  try {
    const content = readFileSync(path, 'utf-8').trim();
    if (!content) return null;
    const id = parseInt(content, 10);
    return Number.isNaN(id) ? null : id;
  } catch {
    return null;
  }
}

/** Check if a contact ID is the owner of any approved chat. */
export function isKnownOwner(contactId: number): boolean {
  for (const chatId of allowedChats()) {
    if (getOwner(chatId) === contactId) return true;
  }
  return false;
}

/** Returns true if at least one approved chat has an owner set. */
export function hasAnyOwner(): boolean {
  for (const chatId of allowedChats()) {
    if (getOwner(chatId) !== null) return true;
  }
  return false;
}

/** A paired device — a contact that owns at least one approved chat. */
export interface PairedDevice {
  contactId: number;
  /** Chats this contact owns, sorted ascending. */
  chatIds: number[];
  /** Earliest approved-file mtime across owned chats (ms since epoch). */
  pairedAtMs: number;
}

/**
 * List all paired devices (unique owners across the allowlist) with their
 * owned chats and the earliest pair timestamp (from approved-file mtime).
 * Chats without an owner (legacy) are ignored — they pre-date the pair
 * flow and have no contact to surface.
 */
export function listPaired(): PairedDevice[] {
  const now = Date.now();
  const map = new Map<number, { chatIds: number[]; pairedAtMs: number }>();
  for (const chatId of allowedChats()) {
    const ownerId = getOwner(chatId);
    if (!ownerId) continue;
    let mtimeMs = now;
    try {
      mtimeMs = statSync(join(_approvedDir, String(chatId))).mtimeMs;
    } catch {
      /* keep fallback */
    }
    const entry = map.get(ownerId);
    if (entry) {
      entry.chatIds.push(chatId);
      if (mtimeMs < entry.pairedAtMs) entry.pairedAtMs = mtimeMs;
    } else {
      map.set(ownerId, { chatIds: [chatId], pairedAtMs: mtimeMs });
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

/** Return chatIds owned by the given contact. */
export function chatsForOwner(contactId: number): number[] {
  const out: number[] = [];
  for (const chatId of allowedChats()) {
    if (getOwner(chatId) === contactId) out.push(chatId);
  }
  return out.sort((a, b) => a - b);
}

/** Revoke a chat ID. Silently ignores missing files. */
export function removeChat(chatId: number): void {
  try {
    unlinkSync(join(_approvedDir, String(chatId)));
  } catch {
    // ignore
  }
}
