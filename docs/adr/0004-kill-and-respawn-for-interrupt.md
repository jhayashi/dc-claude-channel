# ADR-0004: Kill-and-respawn for interrupt

**Status:** Accepted (planned for v1.3, see #21)
**Date:** 2026-05-01

## Context

Users want a way to interrupt a long-running subagent turn — the chat-mediated equivalent of Ctrl+C in a terminal. Three implementation paths exist:

1. **Stream-json control frame.** The Claude Agent SDK's `interrupt()` method writes `{type: "control_request", request: {subtype: "interrupt"}}` over its bidirectional channel. Clean, no lost work, but in this codebase we drive `claude -p` directly (no SDK dependency); whether the CLI binary honors control frames in `-p` mode is undocumented and unverified ([upstream tracker: anthropics/claude-code#51078](https://github.com/anthropics/claude-code/issues/51078)).
2. **SIGINT.** Documented but flaky — [anthropics/claude-code#25629](https://github.com/anthropics/claude-code/issues/25629) reports hangs requiring manual recovery.
3. **SIGTERM kill + `--resume` respawn.** Use the existing eviction path. Next user message cold-spawns under `--resume <sessionId>`, rehydrating prior turn history. The aborted turn appears in the transcript as an interrupted assistant message.

The 2026-04-10 research notes deferred all three on the grounds that any implementation would be "fragile and lossy." On revisiting, that framing is conservative: an interrupt is **inherently lossy by definition** — the user is asking to abandon in-flight work — so lossiness isn't a strike against the approach, only a property of it.

## Decision

Implement `/stop` (and `!!` per #21) as **SIGTERM kill + `--resume` respawn**. Spawn `claude` in its own process group (`detached: true` + signal the negative PID) so SIGTERM cascades to any child processes the subagent had running (e.g., a long Bash command).

Track upstream control-frame work as a future enhancement that would let us interrupt without losing the in-flight turn — but don't block on it.

## Consequences

**Benefits.**

- Ships today; no upstream dependency.
- Reuses the existing eviction path (`subagent-cache.evict()` with reason `user_abort`). No new code path for the kill itself.
- `--resume` continuity is genuinely good: the model rehydrates the transcript and "knows" what it was doing.
- Process-group spawning prevents orphaned grandchildren (long bash commands, network requests).

**Costs.**

- ~10s respawn latency on the next user message. Acceptable for an abort UX.
- Whatever tool call was mid-flight dies. Side effects (partial file edits, half-completed git commands, unflushed buffers) are visible in the working tree after; the user accepts those by asking to stop.
- Original `!!` spec asked for "Claude pauses and summarizes its current work." Kill-and-respawn can't do that mid-process; deferring the summary feature to a follow-up that synthesizes a "summarize the last turn before the interrupt" prompt post-respawn.

**Rejected alternatives.**

- *Wait for upstream control frames.* Rejected: blocks an obviously-useful feature on a tracker with no committed timeline. The kill-and-respawn approach has the same user-visible effect (turn stopped, fresh conversation) for the cost of one cold spawn.
- *SIGINT.* Rejected: documented to hang ([#25629](https://github.com/anthropics/claude-code/issues/25629)). SIGTERM works.
- *Side-channel "current step" status file.* Rejected: only as fresh as the subagent updates it; stale exactly when a stuck subagent would matter most.
- *Between-turn injection (queue `!!`, deliver after current turn ends).* Rejected: defeats the use case — if Claude is mid-Bash on a 5-minute test suite, the user has given up by the time the queued message lands.

## Related

- [#21](https://github.com/jhayashi/dc-claude-channel/issues/21) — interrupt feature tracking
- [Upstream: anthropics/claude-code#51078](https://github.com/anthropics/claude-code/issues/51078) — stream-json cancel/supersede primitive that would unblock a non-lossy interrupt
- ADR-0001 — the LRU cache and `--resume` mechanic that this decision relies on
