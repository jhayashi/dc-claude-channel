# Changelog

All notable changes to this project are documented here. Dates are in `YYYY-MM-DD`.

## [1.0.32] — 2026-04-19

Patch release. Fixes `/deltachat:setup` on fresh marketplace installs.

### Fixed
- **`/deltachat:setup` skill now uses the correct MCP tool prefix.** Plugin-scoped MCP tools are exposed as `mcp__plugin_<pluginname>_<servername>__*`, not `mcp__<servername>__*`. The skill's `allowed-tools` list referenced the wrong prefix, so Claude's pre-flight check concluded the tools weren't registered and (misleadingly) told users the `--dangerously-load-development-channels` flag was missing. Updated all references from `mcp__deltachat__` to `mcp__plugin_deltachat_deltachat__`.

## [1.0.31] — 2026-04-19

Patch release. Fixes a false-positive banner introduced in 1.0.3.

### Fixed
- **Channel-flag detection now walks the full ancestor process tree** instead of checking only `$PPID`. On setups where the hook is spawned via a shell or node intermediate, the original check missed the real `claude` process and wrongly declared `--dangerously-load-development-channels` missing even when it was present. Walks up to 8 ancestors, uses `ps -ww` on macOS to avoid argv truncation, and includes a one-line diagnostic in the warning banner when it does fire so future false positives can be diagnosed without guessing.

## [1.0.3] — 2026-04-18

Setup-flow overhaul. Replaces the ad-hoc tutorial state machine with an agent-driven onboarding, unifies pairing under a single `/deltachat:setup` skill, and adds a terminal escape hatch for removing paired devices.

### Added
- **`/deltachat:setup` skill** — one verb, three subcommands (`pair <code>`, `unpair`, `list`). Arms a 5-minute pairing window, fetches the invite URL, and hands off to the phone-side QR flow.
- **Paired-devices screen** in the agent-setup card — list owned contacts, freeze (read-only + farewell) or delete per device, right from the WebXDC UI.
- **`/deltachat:setup unpair`** terminal escape hatch — same flow as the WebXDC screen, driven by `dc_access_unpair`.
- **Install + unpaired banners** on every launch until the first pair, with uninstall hint for users who picked the plugin by mistake.
- **Channel-flag detection** in the `SessionStart` hook — warns if the user forgot `--dangerously-load-development-channels`.

### Changed
- Pair-on-verified-contact now materializes a Claude chat on the phone side automatically, removing a manual step.
- Tutorial state machine replaced with an agent-driven prelude — the bound agent handles the "say hi" welcome flow directly instead of a hard-coded dialogue tree.

### Fixed
- `stt`: multilingual Whisper models now use `language='auto'` (was hardcoded `en`, which broke non-English transcription on base/small/medium/large models).

## [1.0.2] — 2026-04-18

Feature release: visual refresh of the helper apps, runtime-composed agent badges, a real bidirectional session-resume model, a send-to-terminal flow, a templates gallery, and Marp slide rendering inside the Reviewer.

### Visual refresh

- **Permissions**, **Agent & Chat Setup**, and **File Reviewer** apps all redesigned. New tokens, tighter spacing, consistent affordances across the three cards.

### Runtime agent badges

- Per-agent avatars are now composed at use time from a vendored Lucide glyph + an archetype/tier palette. No more pre-baked PNG set.
- **Manual step after upgrade:** wipe the cache so existing agents re-render — `rm -rf ~/.claude/channels/deltachat/agent-badges/`.

### Session resume

- **Rename** — `teleport` → `resume` across commands, UI, and docs.
- **Per-chat `workingDir`** on each binding. DC and terminal now share a single on-disk `.jsonl` per session — no copy/sync when moving a session between them.
- **Persistent `sessionId → agentId` index** so resumed sessions re-attach to their original agent identity.
- **Live-session filter** hides `.jsonl`s currently held open by another terminal.

### Send-to-terminal

- New agent-setup screen that atomically migrates a DC chat to a local terminal session: emits a `cd … && claude --resume <uuid>` command, migrates scheduled jobs, and tears down the DC chat. Complements the existing DC ↔ terminal resume path.

### Templates + archetypes

- New-agent creation opens on a template gallery (Scheduler, News Briefing, Personal Assistant, …). Each agent carries an archetype that drives its badge palette.
- Tool picker flags MCP servers that still need authentication.

### Slide mode in Reviewer

- Marp decks auto-render as an interactive deck inside the file reviewer — arrow keys, space, swipe, dot indicators. Block-level commenting still works, with slide-aware anchors (`Slide N / Block M`).
- The standalone slide-viewer app is retired; `dc_send_slides` remains as a thin alias to `dc_send_file`.

### Platform fixes

- Schedule-store atomic writes use a PID+UUID tmp suffix in both `save()` and `moveForChat()`.
- Familiar apps re-validate `senderAddr` on persisted reload.
- Send-to-terminal now runs full chat cleanup so scheduled jobs don't leak.
- STT `_resetSttWorker` gets pending-rejection coverage.

---

## [1.0.1] — 2026-04-14

Feature release: adds **session teleport** — seamlessly move conversations between Delta Chat and a local terminal `claude` session in either direction.

### Session teleport

- **DC → terminal (`dc_teleport`)** (#41) — ask "teleport this to my terminal" and the subagent emits a one-line `cd … && claude --resume <uuid>` command. Paste it in a terminal to resume the exact conversation with full history. The DC subagent goes quiet once the terminal takes the session lock.
- **Terminal → DC (agent-setup card)** (#41) — the agent-setup card gains an **Import terminal session** pane (opened via `dc_propose_agent mode="teleport-import"` or by saying "import my terminal session" in chat). Lists sessions from the last 48 hours with timestamps, message counts, and a live-session badge. Picking one creates a new DC chat bound to that session UUID — the next message resumes the terminal history.
- **Pure helpers** — `plugin/teleport.ts` provides `buildResumeCommand`, `listResumeCandidates`, and `attachSessionToChat`. Bounded 4 KB first-line reads for metadata, size-based message-count estimation, and `fuser(1)` live-session detection. CWD resolved via `import.meta.url` so the dispatcher works from any launch directory.
- **Bidirectional channel instructions** — subagents are taught when to call `dc_teleport` (DC → terminal) and when to open the import pane (terminal → DC), including session-lock warnings.

### Docs

- README, CLAUDE.md, and CHANGELOG updated with teleport documentation.

---

## [1.0.0] — 2026-04-13

First stable release. Adds **local voice transcription** via whisper, the **Familiar WebXDC pattern** (Claude-authored WebXDC apps with a live JS handler backend), and a full **pre-release security review** with hardening fixes across both.

### Whisper voice transcription + activity reactions

- **Local voice transcription** — voice messages (.m4a) are transcribed via `@napi-rs/whisper` (prebuilt native bindings to whisper.cpp) before reaching the subagent. No system dependencies — no cmake, g++, or ffmpeg. Models auto-download from Hugging Face on first use to `$DC_STATE_DIR/whisper-models/`. Config via `DC_STT_ENABLED`, `DC_STT_MODEL`, `DC_STT_ECHO`, `DC_STT_TIMEOUT_SEC`, `DC_STT_MAX_DURATION_SEC`. Audio is decoded natively via Symphonia and inference runs in a cached Worker thread so the model stays loaded across calls. Default model: `base.en` (English-only, ~140 MB, interactive speed).
- **Voice activity reactions** — 👂 reaction on the voice message during transcription, thinking emoji on the transcript echo, inclusion in the tutorial recap, guidance on missing deps.
- **Fixes** — drop sub-0.5 s audio to eliminate whisper's silent-input hallucinations (`MIN_AUDIO_DURATION_SEC = 0.5`); move inference into a cached Worker; reject pending transcriptions when the worker is reset (terminate doesn't fire onerror, so callers would otherwise hang); `statSync` fallback when `msg.fileBytes` is unreliable; wait for the full attachment download before dispatching messages.

### Familiar WebXDC pattern

- **Familiar runtime** (#35) — subagents can build interactive WebXDC apps on the fly with Claude acting as the backend. Each Familiar is HTML (the client) + a JS handler string (server-side logic) running in an eval sandbox inside the dispatcher. Handlers have access to `ctx.state` (persistent, optional), `ctx.sendUpdate()`, and `ctx.requestLLM()`. Ephemeral or persistent (saved to `~/.claude/channels/deltachat/familiars/` and reloaded on dispatcher startup). Four tools: `dc_familiar_create`, `dc_familiar_update`, `dc_familiar_list`, `dc_familiar_delete`. `.familiar.yaml` files can be sent as attachments for import.
- **`ctx.requestLLM`** (#35) — Familiar handlers can dispatch a full agent turn for LLM-backed responses, wired through the dispatcher's existing subagent machinery.
- **`webxdc-builder` skill** (#35) — teaches subagents when to use static WebXDC vs Familiar, the mandatory HTML rules (senderAddr owner verification, `textContent` for LLM output, replay safety, debounced sendUpdate), and reference patterns for counter / poll / Pure-LLM / hybrid / multi-user apps. Counter uses a `serverCount + pendingDelta` JS-var pattern; poll includes a client snippet; Pure-LLM has a concrete `textContent` rendering example; `ctx.requestLLM` has a cost callout.

### Security review & hardening

- **Sandbox hardening** — shadow `Function`, `eval`, and `WebAssembly` as `undefined` inside the handler eval context (closes the easy `Function('return globalThis')()` escape); `Object`, `Array`, and `Function` prototypes are frozen at dispatcher startup as defence in depth against prototype-pollution escapes. The `({}).constructor.constructor` path remains and is documented — user review of the handler source is the primary gate.
- **Tighten `validateHtmlSenderAddr`** — parse each `sendUpdate(...)` argument by bracket balance instead of count-matching `senderAddr` against the whole file, so comments and string literals can't create false-positive matches.
- **Per-msgId promise-chain serialization for WebXDC update handlers** — back-to-back updates for the same app no longer race inside the handler.
- **Drop instances + persisted files in `cleanupChat`** — deleting a paired chat now fully tears down its Familiars instead of leaving orphaned disk files.
- **Synthesize `manifest.toml` per Familiar** — each app's title appears in the DC app list instead of a shared static name.
- **120 KB UTF-8 payload cap on `sendUpdate`** — oversized updates are dropped with a typed `handler_error` diagnostic; `dc_familiar_update` returns `isError`. Matches the file-reviewer cap.
- **Full UUID app IDs + mkdtempSync leak fix + UUID-suffixed tmp paths** — collision-safe atomic writes; no more concurrent-write clobber.
- **Block dynamic `import()` in sandbox**; handler syntax errors no longer silently drop the create; serialize `sendUpdate` delivery to guarantee ordering.
- **Post-tag follow-ups filed** — #42 (`validateHtmlSenderAddr` on persisted reload), #43 (`cleanupFamiliarForChat` helper for test coverage), #44 (`_resetSttWorker` pending-rejection test), #46 (STT model SHA-256 verification), #47 (group-chat WebXDC under dc-core ≥ 2.48 hashed `selfAddr`), #48 (scheduler tmp-path UUID suffix).

### Docs

- **`CLAUDE.md`** documents the Familiar runtime, voice transcription, and the `webxdc-builder` skill.

---

## [0.9.5] — 2026-04-12

Feature release: adds **per-agent tool access**, **agent import/export**, **MCP server toggles**, and the **Marp slide viewer**.

### Added
- **Per-agent tool access** (#16) — each agent can restrict which built-in tools and MCP servers its subagent may use. Built-in tools have fine-grained per-tool control; MCP servers are all-or-nothing toggles. `allowedBuiltinTools` and `allowedMcpServers` fields on the agent definition; enforced at spawn time via `--allowedTools`. The agent-setup WebXDC card includes a collapsible tool picker with per-tool checkboxes for built-in tools and per-server toggles for MCP servers.
- **MCP server toggles** — global MCP servers are now exposed in the tool picker as all-or-nothing toggles alongside DC Tools. Agents can selectively enable/disable access to each server. Known servers are registered in `KNOWN_MCP_SERVERS`; Claude Code silently ignores prefixes for absent servers.
- **Agent import/export** (#15) — export agent definitions as `.yaml` files via the agent-setup card ("Export" button); import by sending a `.yaml` attachment into any paired chat. Auto-resolves ID collisions with `-2`, `-3` suffixes. Round-trip compatible with Claude Managed Agents API format.
- **Marp slide viewer WebXDC app** (#34) — `dc_send_slides` tool renders Marp-format slide decks (YAML frontmatter + `---` separators) as interactive presentations in Delta Chat.
- **Onboarding: agent creation step** (#13) — the tutorial flow now prompts users to create their first agent.
- **Built-in default agent** (#29) — `claude-code` agent is auto-seeded and cannot be deleted, ensuring the agent list is never empty.
- **File reviewer: markdown web links** (#33) — clickable links in rendered markdown.

### Changed
- **Activity reactions: randomized emoji pools** — thinking, reading, coding, and planning reactions now draw from randomized pools instead of fixed emojis. Thinking uses a pool of 9 emojis; reading, coding, and planning each have 3–4 variants.
- **Permissions app: handle new prompts while open** (#19) — the permission card now picks up new tool-approval requests that arrive while the card is already displayed.

### Fixed
- **Agent-setup modal no longer persists on card re-open** (#23) — stale confirmation dialogs are suppressed when the card is reopened.
- **Agent-setup: open directly on create form** (#31) — `mode="create"` now correctly opens the create screen instead of the agent list.

### Docs
- `CLAUDE.md` documents per-agent tool access, MCP server toggles, and agent import/export.

---

## [0.9.1] — 2026-04-11

Quality-of-life release: adds scheduled jobs, activity reactions, and several file-reviewer and agent-setup polish items on top of the 0.9 subagent architecture.

### Added
- **Scheduled jobs (`dc_schedule` / `dc_schedule_list` / `dc_schedule_delete`)** — subagents can register recurring or one-shot prompts. Jobs persist to `~/.claude/channels/deltachat/schedules/` and are owned by the dispatcher's in-process scheduler, so they survive subagent eviction, idle timeout, and crashes. Missed fires during downtime are skipped; past-due one-shots are reaped at startup. Soft warning when a new schedule would fire >30 times in the next 7 days.
- **Activity reactions** — while a skip-permissions subagent runs, the dispatcher emits DC emoji reactions on the triggering user message to show what Claude is doing (🔍 reading, 👨‍💻 editing, ⚙️ running commands, 🌐 web, 🤝 subtask, ✍️ planning). `TodoWrite` progresses through 1️⃣–9️⃣ then 🇦–🇿 by in-progress step index. Reactions debounce per emoji class and reset per turn.
- **File reviewer: `yaml` / `json` support and language auto-detection** — `dc_send_file` now detects the language from `file_path` extension when not explicitly set; markdown extensions are intentionally left undetected so the viewer renders them.
- **Agent setup: mirror-orientation icon variants** (#22) — adds randomized mirror variants for the default icon set.

### Fixed
- **Scheduler dispatch surfaces results back to the chat** — scheduled jobs now deliver the subagent's final text plus any policy-denial summary to the chat on each fire, and dispatch errors are reported instead of lost. Without this, jobs fired silently.

### Changed
- **`dc_send_file` is now the default for structured markdown** (#24) — strengthened the file-reviewer channel instructions so Claude defaults to sending plans, proposals, specs, designs, reviews, reports, and any long structured markdown through the file reviewer. Short conversational replies still go inline.
- **File reviewer: sticky tab bar** (#25) — the tab strip stays pinned to the top while scrolling long files.
- **`DC_SUBAGENT_MAX_ACTIVE` default raised 4 → 8** — most users have more than four active chats. Range is still 1–16.
- **Activity-reactions: drop error logging** — failures are swallowed silently; no more noisy log lines on transient DC reaction failures.

### Docs
- `CLAUDE.md` now documents `dc_schedule` and the updated subagent cache defaults.

---

## [0.9] — 2026-04-10

Major release: introduces the **subagent-per-chat** architecture, reusable **agent definitions**, and **skip-permissions** trusted-agent mode.

### Added
- **Subagent-per-chat dispatcher** — every paired chat that recently sent a message is handled by its own persistent `claude -p` process in an LRU cache (default 8 active, 15 min idle). Cold spawn ~6 s, warm turn sub-second. Per-chat session UUIDs enable `--resume` on respawn, preserving TodoWrites / plans / tool outputs across evictions.
- **Agent definitions + bindings split** — agents are now portable YAML files under `~/.claude/channels/deltachat/agents/` that match the Claude Managed Agents schema (`name`, `model`, `system`, `tools`). A per-chat binding (`~/.claude/channels/deltachat/bindings/<chatId>.json`) links a chat to an agent and holds the session UUID and `inheritClaudeMd` flag. Editing an agent mutates it in place — the next turn in every bound chat runs under the new prompt.
- **Agent setup WebXDC app** — pick an existing agent or create a new one from a chat card; includes screen for editing existing agents, binding counts, current-agent highlighting, and edit/delete flows. Orphaned bindings are auto-detected and cleaned up.
- **Skip-permissions mode for trusted subagents** (#18) — an agent can opt into trusted mode via `x-dc-skipPermissions` (checkbox in the setup card). The dispatcher auto-approves tool calls for that agent and appends to `~/.claude/channels/deltachat/audit/<chatId>.md` instead of showing the WebXDC permission card. New `dc_show_audit` core tool lets the subagent send the audit file back via the file reviewer.
- **`dc_react` tool** — subagents can add/clear reactions on DC messages. User reactions on a subagent message are surfaced as synthetic turns so the subagent can respond.
- **`dc_exit_session` tool + 20-minute turn timeout** — subagents can cleanly exit a chat; long-running turns are bounded.
- **Permission relay via PreToolUse hook + Unix socket** — built-in tool permissions from subagents flow through a PreToolUse hook that connects to the dispatcher's Unix socket (`dispatcher.sock`). The dispatcher forwards to the existing WebXDC permission flow in the bound chat, enforcing `chat_id` authorization at the socket boundary so a subagent bound to chat A cannot target chat B.
- **Tools-proxy MCP for subagents** — DC tool calls (`dc_send`, `dc_send_file`, `dc_chat_history`, …) from subagents are proxied over the same socket with per-chat authorization.
- **Auto-pair and auto-bind on 1:1 chat** — new 1:1 pairings auto-bind to the default agent; unbound chats self-repair on first message.
- **Orphan auto-delete in `cleanupChat`** — abandoned chats are reaped automatically.
- **Inherited user settings in subagents** — subagents inherit user-level skills, hooks, and Superpowers from `~/.claude`.
- **Fresh/resume/resume-failed spawn notices dropped** — replaced with a single 🔄 reaction on the user message during cold spawn.

### Changed
- **Rename: group → agent terminology** across commands, WebXDC apps, and docs. `dc_update_group_prompt` → `dc_update_agent`, "Group Setup" → "Agent Setup".
- **Subagents see the whole repo, not just `plugin/`** — the working directory sandbox now spans the full project.
- **Default subagent model: Sonnet** — per-agent `model` arg still overrides.

### Fixed
- `senderAddr` included in every agent-setup server response payload (prior omission caused update rejection).
- Clear stale session before recursive spawn in auto-repair flow.
- `error_during_execution` frames handled cleanly in `SubagentProcess.send()`.
- Terminal-generated permission prompts no longer misroute through DC.
- Orphan cleanup: only kill `PPID==1` to avoid racing sibling dispatchers.
- 1:1 chats trusted unconditionally in `webxdc-filter`; groups use TOFU.

---

## [0.8.3] — 2026-04-07

Onboarding and polish release.

### Added
- **SessionStart hook** — channel auto-loads on Claude Code session start.
- **Auto-pair on first DM** — streamlines the pairing flow so users don't have to type a code.
- UI and markdown polish across the permissions card and file reviewer.

---

## [0.8.1] — 2026-04-07

### Changed
- **Replace `zip` subprocess with `fflate`** — WebXDC app builds no longer shell out to `zip`, removing that system dependency.

### Docs
- Drop `install.sh`; lead with the marketplace install path everywhere.

---

## [0.8.0] — 2026-04-06

First marketplace release.

### Added
- **Marketplace catalog + `/plugin marketplace add` install path** (#8).
- **File reviewer** (renamed from `markdown-viewer`) — rendered markdown + syntax-highlighted source + inline per-line and per-paragraph commenting. 12+ supported languages. Per-row comments on markdown tables.
- **Auto-cleanup of abandoned chats** on member removal (#7).
- **Matching flat icons** for file reviewer and permissions cards.
- **Terminal QR code** for the bot invite link.
- **Comparison table and setup docs** in README.

### Fixed
- Widen file-reviewer gutter for easier long-press commenting on mobile.
- Disable text selection on source lines for easier mobile commenting.
- Correct invite-link and pairing instructions.

---

## [0.1.0] — Initial release

First public release of the Delta Chat channel for Claude Code.

- Dispatcher server + MCP bridge to the user's terminal Claude Code session.
- WebXDC apps: permissions prompt, markdown viewer.
- File-based allowlist + pairing codes.
- `deltachat-rpc-server` integration.

[1.0.32]: https://github.com/jhayashi/dc-claude-channel/compare/v1.0.31...v1.0.32
[1.0.31]: https://github.com/jhayashi/dc-claude-channel/compare/v1.0.3...v1.0.31
[1.0.3]: https://github.com/jhayashi/dc-claude-channel/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/jhayashi/dc-claude-channel/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/jhayashi/dc-claude-channel/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/jhayashi/dc-claude-channel/compare/v0.9.5...v1.0.0
[0.9.5]: https://github.com/jhayashi/dc-claude-channel/compare/v0.9.1...v0.9.5
[0.9.1]: https://github.com/jhayashi/dc-claude-channel/compare/v0.9...v0.9.1
[0.9]: https://github.com/jhayashi/dc-claude-channel/compare/v0.8.3...v0.9
[0.8.3]: https://github.com/jhayashi/dc-claude-channel/compare/v0.8.1...v0.8.3
[0.8.1]: https://github.com/jhayashi/dc-claude-channel/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/jhayashi/dc-claude-channel/releases/tag/v0.8.0
