# Changelog

All notable changes to this project are documented here. Dates are in `YYYY-MM-DD`.

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

[0.9.1]: https://github.com/jhayashi/dc-claude-channel/compare/v0.9...HEAD
[0.9]: https://github.com/jhayashi/dc-claude-channel/compare/v0.8.3...v0.9
[0.8.3]: https://github.com/jhayashi/dc-claude-channel/compare/v0.8.1...v0.8.3
[0.8.1]: https://github.com/jhayashi/dc-claude-channel/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/jhayashi/dc-claude-channel/releases/tag/v0.8.0
