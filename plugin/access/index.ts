/**
 * Access module barrel.
 *
 * `import * as access from './access/index.js'` remains the convention.
 * Submodules:
 * - `./chat-allowlist.ts` — persistent `approved/<chatId>` store
 * - `./pairing.ts` — in-memory arm window + pending codes
 * - `./principals.ts` — Phase 0 skeleton for the principal model
 *   (docs/specs/2026-04-20-identity-and-teams-design.md)
 */

export * from "./chat-allowlist.js";
export * from "./pairing.js";
export * from "./principals.js";
