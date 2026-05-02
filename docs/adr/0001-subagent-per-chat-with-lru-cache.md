# ADR-0001: Subagent-per-chat with LRU cache

**Status:** Accepted
**Date:** 2026-04-15 (backfilled 2026-05-01)

## Context

Every paired chat needs to handle inbound messages by talking to Claude. Three plausible architectures:

1. **Single multiplexed session.** One `claude` process handles all chats, identifying which chat a message belongs to by tagging.
2. **Per-message cold spawn.** Spawn `claude -p`, deliver one message, exit.
3. **Per-chat persistent subagent with LRU cache.** Spawn `claude -p` once per chat, keep alive across turns, evict idle ones.

Constraints shaping the choice:

- `claude -p` cold-spawn is ~10s of latency on every message — too slow for conversational UX.
- Conversation history is rehydrated via `--resume <sessionId>`, but only if the prior session is reachable (sessionId stored in the binding).
- Each subagent needs its own conversation state (in-flight tool calls, scratch context); multiplexing one process across chats would require external state-management we'd otherwise get for free.
- Memory pressure: a long-tail of dormant chats shouldn't keep N processes alive forever.

## Decision

Per-chat persistent subagent processes, kept warm in an LRU cache (default 8 active, 15 min idle timeout). Cold spawns only on cache miss. Session UUID persisted on the binding so `--resume` rehydrates prior turns when a chat re-enters the cache.

## Consequences

**Benefits.**

- Warm-path turns are conversational latency (~1s to first token), not cold-spawn latency.
- Each subagent owns its own state — no per-message correlation logic in the dispatcher.
- LRU eviction caps process count and memory; idle eviction releases dormant chats automatically.
- `--resume` recovers history naturally on cache miss; no custom transcript replay.

**Costs.**

- Cache size + idle timeout become tuning parameters. Bad values cause either memory bloat or excessive cold spawns.
- Process kills (OOM, crash, manual restart) lose in-flight turn state; recovery relies on `--resume` rehydrating from the prior committed turn.
- Each subagent holds an open MCP socket to the dispatcher; stale connections must be cleaned up on eviction.

**Rejected alternatives.**

- *Single multiplexed session.* Rejected: requires building per-chat state isolation we'd inherit for free from process boundaries; one stuck tool call would block all chats.
- *Per-message cold spawn.* Rejected: ~10s latency per message is conversationally unusable.
