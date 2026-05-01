# ADR-0003: Principals (contact identity) as the trust source

**Status:** Accepted
**Date:** 2026-04-25 (backfilled 2026-05-01, ref. v1.2.2 / #66 Option A)

## Context

Pre-v1.2.2, the answer to "is this contact trusted to interact with the bot" was the chat-allowlist (`approved/<chatId>`) and the per-chat owner record. This worked when each contact had exactly one chat with the bot, but broke down for the realistic case:

- A contact already paired in chat X opens a new chat Y with the bot. The chat-allowlist gate sees Y as unapproved and forces another QR/code ceremony. From the contact's perspective, they already proved who they are.
- Multi-user groups: deciding who's allowed to drive the bot in a group chat is per-contact, not per-chat.
- Per-contact unpair (revoke this person's trust regardless of which chats they're in) has no clean home in a chat-keyed model.

The trust boundary should be **contact identity**, not **chatId**.

## Decision

Per-contact identity records — **principals** — at `~/.claude/channels/deltachat/principals/humans/<contactId>.json`. The principal record is the source of truth for "is this contact trusted." Reads consult `isContactPermissioned(contactId)`; the legacy chat-allowlist remains as a fallback for pre-Phase-2 installs and as the per-chat owner record.

Per-contact unpair wipes the principal record (and prevents resurrection by the dispatcher's startup backfill).

## Consequences

**Benefits.**

- **Auto-pair across chats.** A paired contact can land in any new chat with the bot and the dispatcher silently approves — the trust boundary is who they are, not which chat. No re-running the QR ceremony.
- **Per-contact revocation.** Unpairing wipes the principal record once; all of that contact's chats lose access without per-chat cleanup.
- **Multi-user readiness.** Group chats can authorize per-sender on the basis of principal records, not chat ownership. Unblocks #37, #70.
- **Cross-cutting trust queries.** "Does any contact have trust" is a single directory scan; "is this contact paired" is a single file existence check.

**Costs.**

- Two-source-of-truth period during the transition. The chat-allowlist still exists; cleanup happens in v1.3 (Option B / #66) when we derive the allowlist from principals + chat membership and drop `approved/`.
- Backfill complexity. Legacy installs without principal records need a one-time migration; dispatcher startup runs `backfillFromAllowlist`.
- Per-contact identity is permanent across the bot's lifetime, which means a misbehaving contact unpaired now could re-pair later (intentional, but worth noting).

**Rejected alternatives.**

- *Chat-keyed allowlist as the only trust source.* Rejected: forces re-pairing on every new chat with the same contact; doesn't extend to multi-user groups; per-contact revocation has no home.
- *Principals as a derived view of the chat-allowlist.* Rejected: derived data fights the goal — we want principals to *be* the source so per-contact operations are first-class.

## Related

- v1.3 #66 Option B (planned) drops `approved/` entirely and derives the chat allowlist from principals + chat membership.
- v1.3 #71 builds capabilities on top: "this contact has principal X and capability Y" is the v1.3 authorization shape.
- #70 (drop third-party messages in groups) is enabled by this — the gate becomes `isContactPermissioned(fromId)` instead of `fromId === owner`.
