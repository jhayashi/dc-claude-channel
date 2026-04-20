# Spec-vs-Code Audit

Consolidated Phase-2 findings from [#64](https://github.com/jhayashi/dc-claude-channel/issues/64). Each item was surfaced while writing the per-area specs and cross-checking against source. The per-file "Audit notes" sections remain canonical; this file prioritises for triage.

## Legend

- **Type**: `gap` (behaviour exists but undocumented), `bug` (code does wrong thing), `contradiction` (two paths disagree), `race` (concurrency hazard), `orphan` (dead/unreachable), `doc` (documented limitation, no change proposed).
- **Severity**: `H` ships bad behaviour to users, `M` degrades UX or observability under realistic conditions, `L` edge case or cosmetic, `A` accept as-is.

---

## High — user-visible or correctness-affecting

- [ ] **H / race** — `close_tab` updates from file-reviewer lack `senderAddr` validation; an attacker in a group chat could spoof the close event and cause a legitimate file to be forgotten before the auto-upgrade handshake completes. *(webxdc-apps, finding 4)* Fix: validate `senderAddr` in the `close_tab` branch of `file-reviewer-app.ts`.

- [ ] **H / race** — TOFU-cached `senderAddr`s in group chats never expire or re-verify. A removed group member whose addr is cached can rejoin and impersonate themselves against the WebXDC filter. *(webxdc-apps, finding 3; related to #47)* Fix: expire TOFU entries on `ChatModified` / member-list change events, or cap TTL.

- [ ] **H / race** — Cache eviction during an in-flight permission hook leaves the hook client writing to a closed socket; the hook times out after 300 s and the user sees a denial instead of a clean cancellation. *(subagent-lifecycle, finding 1)* Fix: socket-server should track hook connections per chat entry and short-circuit a clean error on eviction.

- [ ] **H / race** — Socket-level chat-id authorization is validated once at hello but the binding registry can mutate mid-session (agent repair, chat reassignment). Tool calls from a subagent with a just-repointed binding execute with stale authorization. *(subagent-lifecycle, finding 4)* Fix: re-check `chat_id ↔ subagentId` on every `toolCall` frame against the current binding.

- [ ] **H / bug** — Skip-permissions flag (`x-dc-skipPermissions: true`) is preserved on YAML export with no warning or import prompt. Recipients silently inherit auto-approve. *(agents-and-bindings, "Skip-Permissions Leakage")* Fix: strip `x-dc-skipPermissions` on export, or show a confirmation dialog on import when the flag is present.

- [ ] **H / bug** — When a sender is paired but not the owner (e.g. another participant in a group), messages are silently ignored with only a log line — unlike unpaired senders who trigger the pairing flow. From the user's side the bot looks broken. *(subagent-lifecycle, finding 8)* Fix: post a one-shot "this bot only talks to its owner" reply, or at minimum a reaction.

## Medium — reliability, observability, hygiene

- [ ] **M / race** — Teleport-out schedules subagent eviction 5 s after tool return. A user message during that window spawns a second subagent that races the terminal for the same session lock. *(resume, "Teleport-out mid-turn")* Fix: make the grace period explicit in the commit response and/or block dispatch during the window.

- [ ] **M / race** — `version_mismatch` handshake can double-fire when two handler instances both see the stale version. Second rebuild can race the first's msgId registration, so its update lands on an unregistered msgId. File-reviewer guards via `activeViewers`; permissions-app has no equivalent. *(webxdc-apps, finding 6)* Fix: add a single-flight guard keyed by chat-id in `permissions-app.ts`.

- [ ] **M / race** — Crash + LRU-evict can both call `close()` on the same process. No double-close guard; second path logs a noisy error. *(subagent-lifecycle, finding 3)* Fix: short-circuit `close()` if `alive === false`.

- [ ] **M / race** — Orphaned frames/waiters in `subagent-process.ts` can grow `frameQueue` unbounded when a frame's predicate never matches before the waiter times out. *(subagent-lifecycle, finding 7)* Fix: when a waiter times out, purge frames tagged for that waiter.

- [ ] **M / bug** — Rate-limit hits return boolean and drop the tool call silently from the subagent's perspective. No error surfaced to Claude. *(subagent-lifecycle, finding 10)* Fix: return a structured MCP error so the subagent can retry or back off.

- [ ] **M / bug** — Pairing-code expiry (>1 h without `pair <code>`) produces a cryptic error. No in-chat "window closed, re-arm" message. *(pairing, finding 10)* Fix: post explicit expiry message in the pending chat.

- [ ] **M / bug** — A stale QR scan from an unknown contact (when a primary owner is already established) is silently dropped. User watching the QR side sees nothing. *(pairing, finding 3)* Fix: surface a "not authorised" response via a securejoin-layer error.

- [ ] **M / bug** — Every re-arm of `/deltachat:setup` leaves the previous "Claude" group chat on the bot side. Users who retry a few times accumulate stale groups. *(pairing, finding 4)* Fix: delete the previous pending group on re-arm.

- [ ] **M / bug** — `permissionsSessions` and file-reviewer `activeViewers` maps are not cleared on chat unpair. Low-risk leak but real. *(webxdc-apps, findings 8, 9)* Fix: add `delete(chatId)` to the cleanup-event pathway.

- [ ] **M / bug** — Icon cache (`agent-badges/`) has no invalidation on palette or glyph-SVG changes. Upgrades that change visuals require manual `rm -rf`. *(agents-and-bindings, "Icon Cache Invalidation")* Fix: include a palette/glyph version in the cache key.

- [ ] **M / bug** — `x-dc-iconMirror` flips the Delta Chat profile image but not the in-app badge preview. Previews and notifications disagree with the chat list. *(agents-and-bindings, "Icon Mirror Inconsistency")* Fix: apply mirror in the renderer before caching.

- [ ] **M / bug** — `x-dc-glyph` outside the archetype palette silently falls back with no warning. *(agents-and-bindings, "Glyph Palette Mismatch")* Fix: log a one-shot warning at render time; surface in agent-setup card.

- [ ] **M / gap** — Reaction router buffers reactions in memory but never persists. Reactions emitted between buffer and flush are lost on dispatcher crash. *(subagent-lifecycle, finding 12)* Fix: persist pending reactions, or accept + document.

- [ ] **M / gap** — Missed scheduled fires during dispatcher downtime are silently skipped. Acceptable policy, but undocumented in user-facing `dc_schedule` tool output. *(scheduling)* Fix: mention in tool description.

- [ ] **M / gap** — No histogram for turn latency; no cache hit/miss metric. *(subagent-lifecycle, findings 17, 18)* Fix: emit structured log lines for p50/p99 tracking.

## Low — edge cases, cosmetic, deferred

- [ ] **L / orphan** — `isPendingPair()` in `access.ts` is exported but only used in tests. *(pairing, finding 1)* Fix: inline into tests or delete.

- [ ] **L / orphan** — `cache.prewarm(chatId)` may not be exposed by `server.ts`. *(subagent-lifecycle, finding 14)* Fix: verify caller; delete if unreachable.

- [ ] **L / race** — Auto-pair TOCTOU between `isKnownOwner` and `addChat`. Microsecond window; revocation would have to race a first message. *(pairing, finding 2)* Fix: acceptable as-is; note in spec.

- [ ] **L / bug** — Pairing code alphabet excludes lowercase `l` for confusion-prevention but this isn't documented in user-facing help. *(pairing, finding 9)* Fix: one-liner in tutorial copy.

- [ ] **L / bug** — `MAX_PENDING = 3` is per-process; dispatcher restart resets the counter. *(pairing, finding 5)* Fix: persist counter, or accept.

- [ ] **L / bug** — Tutorial state not persisted; restart mid-tour drops progress. *(pairing, finding 7)* Fix: persist state keyed by chat id.

- [ ] **L / bug** — `addChat()` surfaces unclear error when state dir is unwritable. *(pairing, finding 11)* Fix: clearer MCP error text.

- [ ] **L / bug** — ID collision resolution on agent import produces `coach-2`, `coach-3`; no dedup for identical imports. *(agents-and-bindings, "ID Collision on Import")* Fix: content-hash compare and short-circuit if identical.

- [ ] **L / bug** — `session-agents.json` entries accumulate without cleanup when a binding is deleted. Harmless leak. *(resume, "Stale session-agents entries"; agents-and-bindings, "Session-Agents Staleness")* Fix: delete reverse-index entry in `cleanupChatState`.

- [ ] **L / bug** — Stale bindings between dispatcher startup and `sweepOrphans()` can cause null-pointer issues in `resolveChat()`. *(agents-and-bindings, "Stale Bindings")* Fix: run the sweep synchronously before the message router starts.

- [ ] **L / bug** — `resolveChat()` returns null for a binding whose agent file was deleted; no warning until the chat tries to dispatch. *(agents-and-bindings, "Missing Agent Definition")* Fix: log a warning at load time; surface to UI.

- [ ] **L / bug** — Deprecating a model in `ALLOWED_MODELS` locks agents with that model from editing. *(agents-and-bindings, "Model Migration")* Fix: allow "downgrade to latest" migration on open.

- [ ] **L / bug** — Reaction dispatch is fire-and-forget; failures (rate limits, disconnected DC core) swallowed silently. *(subagent-lifecycle, finding 9)* Fix: log at `warn` level.

- [ ] **L / bug** — Orphan-cleanup has no PID lockfile; two dispatchers starting concurrently can kill each other's children via the `ppid=init` heuristic. *(subagent-lifecycle, finding 13)* Fix: add a lockfile or unique dispatcher-id.

- [ ] **L / bug** — Session-start hook walks the process tree up to 8 levels for flag detection; deep shell/tmux/systemd trees fall back to "assume flag present." *(pairing, finding 14)* Fix: accept, or increase the cap.

- [ ] **L / doc** — `SUBAGENT_TOOL_BLOCKLIST` prevents subagents from calling pairing tools; intentional but not inline-documented. *(pairing, finding 12)* Fix: add a code comment.

- [ ] **L / doc** — `DEFAULT_GATED_TOOLS` and `KNOWN_MCP_SERVERS` are hard-coded with no env/config override. *(subagent-lifecycle, findings 15, 16)* Fix: document that both are build-time constants.

- [ ] **L / doc** — `suppressUserClaudeMd` flag is parsed and logged but ignored pending Claude Code support. *(subagent-lifecycle, finding 11)* Fix: comment the flag as "reserved for future use" and stop logging it.

- [ ] **L / doc** — Subagent spawn failures (no agent bound) are logged but not retried; message is lost from the subagent's perspective. Expected behaviour. *(subagent-lifecycle, finding 6)* Fix: document explicitly.

- [ ] **L / bug** — `onQueueDrop()` callback throws are caught silently. *(subagent-lifecycle, finding 19)* Fix: log at `warn`.

- [ ] **L / bug** — Agent metadata schema accepts arbitrary `x-dc-*` keys; typos pass validation and are preserved-but-ignored. *(agents-and-bindings, "Agent Metadata Pollution")* Fix: warn on unknown keys in agent-setup UI.

- [ ] **L / race** — Atomic writes use temp+rename; concurrent writes to the same agent file lose one update. *(agents-and-bindings, "Atomic Write Vulnerability")* Fix: lockfile per agent id, or accept.

- [ ] **L / bug** — `buildResumeCommand()` silently downgrades to `kind: 'fresh'` when sessionId or `.jsonl` is missing. *(resume, "Observable failures")* Fix: surface the downgrade in the tool response.

- [ ] **L / bug** — `isSessionLive()` returns false on fuser-error path; silent fallback. *(resume)* Fix: log once on first miss.

- [ ] **L / bug** — Job-collision in `moveForChat` (target already has same jobId) throws with no recovery path. Requires manual intervention. *(resume, "Job collision on move")* Fix: rename with suffix, or document.

## Accept — intentional limitations, no action proposed

- [ ] **A / doc** — Single-writer invariant on session `.jsonl`; both terminal and DC reading simultaneously corrupts state. Enforced by `fuser` + `isSessionLive()`. Document in README Resume section.

- [ ] **A / doc** — Resume is same-machine only. No cross-device sync. Explicit design constraint.

- [ ] **A / doc** — `workingDir` is write-once per binding. Dispatcher relaunch from a different cwd keeps old bindings on their cached dir. Intentional for session-file-path stability.

- [ ] **A / doc** — Familiar handler sandbox can escape via prototype-chain `Function` constructor. Defense-in-depth only; primary gate is user review at `dc_familiar_create` time. Documented in `familiar-runtime.ts`.

- [ ] **A / doc** — WebXDC `setUpdateListener(fn, 0)` replay is idempotent by design; handlers must be replay-safe. Documented in CLAUDE.md.

- [ ] **A / doc** — Audit log is append-only with no rotation; long-running skip-permissions agents may accumulate large files. *(skip-permissions-audit)* Cleanup is manual.

- [ ] **A / doc** — Audit log stores tool inputs in plaintext; sensitive values (keys, PII) may appear. No redaction. *(skip-permissions-audit)*

- [ ] **A / doc** — Shared auto-memory across all subagents on the same host. Any agent can read/write the shared `MEMORY.md`. *(CLAUDE.md)*

- [ ] **A / doc** — `validateHtmlSenderAddr()` for Familiar HTML has false positives when `senderAddr` appears in a comment or string literal. *(webxdc-apps, finding 1)* Acceptable because alternative (robust JS parse) is out of scope.

- [ ] **A / doc** — `APP_VERSION` monotonicity assumes single-read; edits mid-request are unrealistic in practice. *(webxdc-apps, finding 7)*

- [ ] **A / doc** — Permission-prompt replay on same-msgId is rare because dispatcher reuses msgId via `permissionsSessions`. *(webxdc-apps, finding 15)*

- [ ] **A / doc** — Random pairing codes exclude `l` (lowercase L) to avoid `1`/`I` confusion. *(pairing, finding 9)*

- [ ] **A / doc** — Owner contact ID stored as bare integer; phantom owners still trigger auto-pair if the contact is deleted from DC core. Narrow risk. *(pairing, finding 6)*

---

## Next steps

1. Promote any `H`-severity item that the team agrees warrants its own fix into a standalone issue; reference back here.
2. Keep `M`/`L` items as checkboxes here; strike them as fixes land.
3. Add a "spec still accurate?" line to the release checklist (per #64 acceptance criteria).
4. Wire spec-to-code tie-ins into #63's regression harness where expressible as tests.
