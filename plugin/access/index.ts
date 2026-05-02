/**
 * Access module barrel.
 *
 * `import * as access from './access/index.js'` remains the convention.
 * Submodules:
 * - `./chat-allowlist.ts` — in-memory chats-with-permissioned-member cache (v1.3+)
 * - `./pairing.ts` — in-memory arm window + pending codes
 * - `./contacts.ts` — pure I/O on Contact records (trust annotations on the bot's address book)
 * - `./contact-policy.ts` — derived queries combining contacts +
 *   chat-allowlist (isContactPermissioned, getCapabilitiesFor, etc.).
 *   Split out in v1.3 to break a chat-allowlist ↔ contacts cycle.
 * - `./capability-bundles.ts` — role → capability set
 * - `./capabilities.ts` — per-tool capability evaluator
 * - `./gate.ts` — orchestration helper for the dispatcher's capability gate
 */

export * from "./chat-allowlist.js";
export * from "./pairing.js";
export * from "./contacts.js";
export * from "./contact-policy.js";
export * from "./capability-bundles.js";
export * from "./capabilities.js";
export * from "./gate.js";
