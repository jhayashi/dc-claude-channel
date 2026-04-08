# Phase 1 Feasibility Spike Summary

**Run date:** 2026-04-07
**Branch:** v0.9

| Spike | Status | Verdict |
|---|---|---|
| 1A — persistent subagent round-trip | ✅ PASS | Persistent `claude -p` processes work: 2nd-message wall-clock 1316 ms, parallelism confirmed (3126 ms for two concurrent 5-token generations — same as slower individual), idle RSS 316 MB, in-process continuity confirmed. Original spawn-per-message assumption killed by real cold numbers (~6 s cold, ~10 s resume). |
| 1B — MCP wire protocol over Unix socket | ✅ PASS | Newline-delimited JSON handshake + tool round-trip + bad-secret rejection + unknown-tool error all behave as designed. |
| 1C — `--allowedTools` blocks omitted tools | ❌ FAIL | With `--allowedTools "Bash(echo:*)"`, Claude still successfully Read a file and leaked the secret verbatim. `--allowedTools` is additive to defaults, not restrictive — it cannot be trusted as a security boundary for subagents. (Check 2: MCP-prefixed flag format parses, secondary result ambiguous due to variadic flag behavior.) |
| 1D — `--model` flag in headless | ✅ PASS | `claude -p --model <haiku\|sonnet\|opus>` all accepted in headless mode with exit 0 and expected output. |
| 1E — MCP server as permission channel | ❌ FAIL | MCP servers do not receive built-in tool permission operations. With `--permission-mode default`, `bash -c "echo cobalt"` auto-passed — the loaded MCP server only saw `initialize` + `tools/list` and the stream-json stdout had no `permission_denials` frames. The MCP SDK layer exposes no permission delegation hook. |

## Major design pivot during Phase 1

The original plan assumed spawn-per-message subagents with `--session <id>` for continuity. Spike 1A probing revealed two hard blockers:

1. **Cold-start is ~6 s, `--resume` is ~10 s.** The 1500 ms / 500 ms budgets were unreachable.
2. **No `--session` flag.** Actual flags are `--session-id <uuid>` for the first call and `--resume <uuid>` for follow-ups.

Rewritten Spike 1A validated the **persistent subagent** design: keep `claude -p` processes alive per active chat with stream-json I/O over stdin/stdout. Second-message round-trip drops to ~1.3 s (cache-warm model + in-memory context). The dispatcher will keep a bounded LRU cache of these processes (default `DC_SUBAGENT_MAX_ACTIVE=4`, idle timeout 15 min).

Plan v7 (`docs/plan-issue-1.md`) has the full design. Phase 2.5 (warm pool) was deleted — subsumed by the LRU cache model.

## Decisions triggered

- **Phase 2 go/no-go:** **GO.** The persistent LRU design is validated. Wire protocol works. Model selection works. The permission relay needs a different shape (see below) but isn't a blocker.
- **Phase 2.5 (warm pool):** **DELETED.** Replaced by the LRU persistent-subagent cache inside Phase 2.
- **Phase 4 (per-group model selection):** **IN.** `--model` works in headless for haiku/sonnet/opus.
- **Permission relay shape:** **Pre-baked permission mode per subagent** — NOT socket-delegated to the dispatcher. Spikes 1C and 1E together proved:
    1. `--allowedTools` doesn't actually block anything, so we can't use it as a hard fence.
    2. MCP servers can't receive permission operations, so the "tools proxy doubles as permission channel" idea from plan v3-v6 is dead.
  The realistic replacement: launch each subagent with `--permission-mode acceptEdits` (or `bypassPermissions` if we want zero prompts). The trust boundary is the paired chat owner, not the CLI. Document explicitly in `SECURITY.md`: "the chat owner who pairs a chat implicitly authorizes its subagent to run local tools on their behalf."

## Security posture

The combined 1C + 1E finding forces us to make the trust model explicit:

- The dispatcher still enforces **DC-tool** access (who can send messages to which chat, who can read chat history) via the socket boundary in Phase 2. That gate is real and strong.
- **Built-in tools** (Bash/Read/Edit/Grep/Glob/WebFetch) run inside the subagent with `acceptEdits` (or similar) and are **not** per-action gated. The user implicitly authorized them when they ran `/deltachat:access pair` in their own terminal.
- This is equivalent to the posture Claude Code has today when you type directly into the TUI — the tool actually ran in Task 1's implementation is a best-effort list, not a policy. Making it explicit up front prevents drift.

## Next step

Open `docs/superpowers/plans/2026-XX-XX-phase2-dispatcher-split.md`. The Phase 2 plan must:

- Update the wire protocol to drop `permissionRequest` / `permissionResponse` kinds (they aren't flowing through the tools proxy).
- Add the LRU cache structure to `subagent-spawner.ts`.
- Use `startPersistent` pattern from `plugin/spikes/1a-named-sessions.ts` as the reference implementation for stream-json I/O.
- Launch every subagent with `--permission-mode acceptEdits` and document the rationale in `SECURITY.md`.
- Still enforce DC-tool `chat_id` authorization at the socket boundary — this is the actual security boundary, not `--allowedTools`.
