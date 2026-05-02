/**
 * Pairing flow state for the Delta Chat channel:
 * - `/deltachat:setup` arm window (5-minute window during which the next
 *   verified contact event is treated as the user pairing their phone).
 * - Pending pairing codes (5-letter codes users punch into their terminal
 *   after scanning a QR).
 *
 * Both are in-memory only — they reset on dispatcher restart. Allowlist
 * state (the persistent `approved/<chatId>` files) lives in
 * `./chat-allowlist.ts`.
 */

import { logRoleAssignment } from "../events.js";
import { addChat } from "./chat-allowlist.js";
import { DEFAULT_AGENT_ID, loadContact, recordContactPair } from "./contacts.js";

// --- Constants ---

const CODE_ALPHABET = "abcdefghijkmnopqrstuvwxyz"; // no 'l'
const CODE_LEN = 5;
const PAIRING_EXPIRY_MS = 3_600_000; // 1 hour
const MAX_PENDING = 3;
const ARM_WINDOW_MS = 5 * 60 * 1000; // 5 min pairing arm window

// --- Arm-window state ---
//
// `/deltachat:setup` arms a 5-minute window during which the next verified
// contact event is treated as the user pairing their phone. Without this,
// random QR scans of stale invite links would create unwanted chats.
//
// The armed window also records the "Claude" group chat created for this
// pairing attempt — the skill arms the window, the server creates the group,
// and `dc_invite_link` hands back the group's securejoin QR so the joiner
// lands in a group chat (bot visibly identifies as "Claude") rather than a
// 1:1 where DC hides the peer name.

let _armedUntil: number | null = null;
let _armedGroupChatId: number | null = null;

/** Arm the pairing window. Idempotent — re-arming extends the TTL. */
export function armPairing(groupChatId: number | null, now: number = Date.now()): void {
  _armedUntil = now + ARM_WINDOW_MS;
  _armedGroupChatId = groupChatId;
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
 * Chat ID of the "Claude" group created for the current armed window, or
 * null if no group was recorded (legacy/1:1 flow or no armed window).
 * Returned regardless of whether the window is still within TTL — the
 * server uses this to clean up stale groups on re-arm.
 */
export function getArmedGroupChatId(): number | null {
  return _armedGroupChatId;
}

/**
 * Atomic check-and-clear. Returns true if the window was armed and valid;
 * false if expired or never armed. Either way, clears the state so the
 * next verified-contact event cannot double-consume.
 */
export function consumeArmedWindow(now: number = Date.now()): boolean {
  const armed = _armedUntil !== null && now < _armedUntil;
  _armedUntil = null;
  _armedGroupChatId = null;
  return armed;
}

/** Clear the arm-window state. For tests. */
export function resetArmedState(): void {
  _armedUntil = null;
  _armedGroupChatId = null;
}

/**
 * Clear pending-pairings state. For tests — without this, the
 * module-level `pending` map leaks across test files and the
 * `MAX_PENDING` cap throws spuriously. Future structural fix:
 * factor into `createPairingState()` so each test gets its own
 * instance (deferred Tomas review item).
 */
export function resetPendingPairings(): void {
  pending.clear();
}

// --- Pending pairings ---

interface PendingPair {
  chatId: number;
  contactId: number; // sender's contact ID (the owner)
  createdAt: number; // Date.now()
}

const pending = new Map<string, PendingPair>();

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
  // Capture the previous role BEFORE recordContactPair so the audit log
  // records the actual transition. loadContact may throw on a corrupt
  // existing record (slice-3-5 review fix); treat that as null and
  // proceed — recordContactPair will recover by overwriting.
  let previousRole: string | null = null;
  try { previousRole = loadContact(DEFAULT_AGENT_ID, p.contactId)?.role ?? null; } catch { /* corrupt → null */ }
  // Phase 2: write a Contact record. Idempotent for
  // firstPairedAt; v1.3 slice 6 always sets role=subscriber (terminal
  // pair = subscriber, always). addChat MUST come after this write so
  // the in-memory cache only reflects contacts that have a backing record.
  recordContactPair(DEFAULT_AGENT_ID, p.contactId);
  addChat(p.chatId, p.contactId);
  logRoleAssignment({
    ts: new Date().toISOString(),
    assigneeContactId: p.contactId,
    assignedRole: "subscriber",
    previousRole,
    assignerContactId: null, // terminal session is the implicit actor
    reason: "terminal_pair",
  });
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
