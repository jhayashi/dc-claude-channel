/**
 * Access module barrel.
 *
 * `import * as access from './access/index.js'` remains the convention.
 * Submodules:
 * - `./chat-allowlist.ts` — in-memory permissioned-chats cache (v1.3+)
 * - `./pairing.ts` — in-memory arm window + pending codes
 * - `./principals.ts` — pure I/O on principal records
 * - `./principals-policy.ts` — derived queries combining principals +
 *   chat-allowlist (isContactPermissioned, getCapabilitiesFor, etc.).
 *   Split out in v1.3 to break a chat-allowlist ↔ principals cycle.
 * - `./capability-bundles.ts` — role → capability set
 */

export * from "./chat-allowlist.js";
export * from "./pairing.js";
export * from "./principals.js";
export * from "./principals-policy.js";
export * from "./capability-bundles.js";
export * from "./capabilities.js";
export * from "./gate.js";
