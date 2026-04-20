/**
 * File-based allowlist and pairing flow for Delta Chat channel access control.
 *
 * Approved chat IDs are stored as files under
 * ~/.claude/channels/deltachat/approved/<chatId>.
 * The file contains the owner's contact ID (the person who paired the chat).
 * Legacy empty files (pre-owner tracking) are treated as having no owner.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// --- Constants ---

const CODE_ALPHABET = "abcdefghijkmnopqrstuvwxyz"; // no 'l'
const CODE_LEN = 5;
const PAIRING_EXPIRY_MS = 3_600_000; // 1 hour
const MAX_PENDING = 3;
const ARM_WINDOW_MS = 5 * 60 * 1000; // 5 min pairing arm window
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

// --- Arm-window state (Phase 2) ---
//
// `/deltachat:setup` arms a 5-minute window during which the next verified
// contact event is treated as the user pairing their phone. Without this,
// random QR scans of stale invite links would create unwanted chats.

let _armedUntil: number | null = null;

/** Arm the pairing window. Idempotent — re-arming extends the TTL. */
export function armPairing(now: number = Date.now()): void {
  _armedUntil = now + ARM_WINDOW_MS;
}

/** Is the pairing window currently armed? Non-consuming. */
export function isArmed(now: number = Date.now()): boolean {
  return _armedUntil !== null && now < _armedUntil;
}

/** Timestamp (ms epoch) at which the window expires, or null if not armed. */
export function getArmedUntil(): number | null {
  return _armedUntil;
}

/**
 * Atomic check-and-clear. Returns true if the window was armed and valid;
 * false if expired or never armed. Either way, clears the state so the
 * next verified-contact event cannot double-consume.
 */
export function consumeArmedWindow(now: number = Date.now()): boolean {
  const armed = _armedUntil !== null && now < _armedUntil;
  _armedUntil = null;
  return armed;
}

/** Clear the arm-window state. For tests. */
export function resetArmedState(): void {
  _armedUntil = null;
}

// --- In-memory pending pairings ---

interface PendingPair {
  chatId: number;
  contactId: number; // sender's contact ID (the owner)
  createdAt: number; // Date.now()
}

const pending = new Map<string, PendingPair>();

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

// --- Pairing functions ---

/** Prune expired entries from the pending map. */
function pruneExpired(): void {
  const now = Date.now();
  for (const [code, p] of pending) {
    if (now - p.createdAt > PAIRING_EXPIRY_MS) {
      pending.delete(code);
    }
  }
}

/** Generate a random pairing code using crypto.getRandomValues. */
function generateCode(): string {
  const buf = new Uint8Array(CODE_LEN);
  crypto.getRandomValues(buf);
  let code = "";
  for (let i = 0; i < CODE_LEN; i++) {
    code += CODE_ALPHABET[buf[i] % CODE_ALPHABET.length];
  }
  return code;
}

/**
 * Start a pairing flow for the given chat ID.
 * Returns the pairing code the user must present in their terminal.
 * Throws if the maximum number of pending pairings is reached.
 *
 * @param contactId — the Delta Chat contact ID of the person requesting pairing (becomes the owner)
 */
export function startPairing(chatId: number, contactId: number): string {
  pruneExpired();

  // Return existing code for same chatId.
  for (const [code, p] of pending) {
    if (p.chatId === chatId) {
      return code;
    }
  }

  if (pending.size >= MAX_PENDING) {
    throw new Error(`too many pending pairings (max ${MAX_PENDING})`);
  }

  const code = generateCode();
  pending.set(code, { chatId, contactId, createdAt: Date.now() });
  return code;
}

/**
 * Complete a pairing: validate the code, approve the chat, return the chat ID.
 * Throws on unknown/expired codes.
 */
export function completePairing(code: string): number {
  code = code.toLowerCase().trim();

  const p = pending.get(code);
  if (!p) {
    throw new Error(`unknown or expired pairing code: ${code}`);
  }
  if (Date.now() - p.createdAt > PAIRING_EXPIRY_MS) {
    pending.delete(code);
    throw new Error(`pairing code expired: ${code}`);
  }

  pending.delete(code);
  addChat(p.chatId, p.contactId);
  return p.chatId;
}

/**
 * Check if a code is a valid pending pairing.
 * Returns { chatId } or null if not found / expired.
 */
export function isPendingPair(code: string): { chatId: number } | null {
  code = code.toLowerCase().trim();

  const p = pending.get(code);
  if (!p || Date.now() - p.createdAt > PAIRING_EXPIRY_MS) {
    return null;
  }
  return { chatId: p.chatId };
}
