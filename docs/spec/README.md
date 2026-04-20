# Functional Spec

This directory is the canonical behavioural description of `dc-claude-channel`. Each file is a single feature area, written by reading the code that exists today — not by planning forward. It answers the question: "What is this supposed to do, where does the state live, and what can the user observe?"

See [issue #64](https://github.com/jhayashi/dc-claude-channel/issues/64) for why this exists and how it fits alongside `README.md` (install), `CLAUDE.md` (architecture), and the test suite (module correctness).

## Per-area specs

| Area | What it covers |
|---|---|
| [pairing.md](pairing.md) | `/deltachat:setup`, pairing codes, securejoin, auto-pair by known owners, tutorial state machine, allowlist on disk |
| [subagent-lifecycle.md](subagent-lifecycle.md) | LRU cache of `claude -p` children, idle-timeout eviction, stream-json I/O, Unix-socket protocol (hello / toolCall / permissionRequest / permissionVerdict), reaction mapping |
| [agents-and-bindings.md](agents-and-bindings.md) | Agent YAML registry, per-chat bindings, templates + archetypes, badge rendering, `x-dc-*` metadata, YAML import/export |
| [resume.md](resume.md) | DC ↔ terminal session resume, `workingDir` write-once semantics, session-agents reverse index, `dc_resume_in_terminal`, agent-setup teleport screens |
| [webxdc-apps.md](webxdc-apps.md) | All four WebXDC apps (permissions, file-reviewer, agent-setup, marp) + Familiar runtime, auto-upgrade handshake, owner verification via `senderAddr` + TOFU, payload caps |
| [scheduling.md](scheduling.md) | `dc_schedule` / `dc_schedule_list` / `dc_schedule_delete`, per-job atomic JSON, cron validation, missed-fire skip policy |
| [stt.md](stt.md) | Voice transcription via `@napi-rs/whisper` + Symphonia, model download + hash pinning, worker thread, env-var config |
| [tool-allowlisting.md](tool-allowlisting.md) | `allowedBuiltinTools` / `allowedMcpServers` on the agent definition, legacy-field migration, `--allowedTools` CLI flag format |
| [skip-permissions-audit.md](skip-permissions-audit.md) | `x-dc-skipPermissions` auto-approve path, per-chat markdown audit log, `dc_show_audit` tool |

## Cross-cutting findings

[AUDIT.md](AUDIT.md) consolidates the per-file "Audit notes" sections into a single prioritised list of gaps, contradictions, and orphaned code paths. This is Phase 2 of #64 — each item is a candidate fix, follow-up issue, or explicit "accept and document."

## How to keep this accurate

The spec is intended to be a rolling document — git history gives the version dimension. When a PR changes behaviour:

1. Update the relevant `docs/spec/<area>.md` section in the same PR.
2. If the change adds a new feature area, add a new file and link it from this index.
3. If the change makes an AUDIT.md finding obsolete (fixed or no longer relevant), strike it.

See #64 for the broader proposal (including a planned release-checklist "spec still accurate?" step and a future regression-test tie-in via #63).

## Conventions

- **File-to-code pointers** — every section lists the primary source files, so a reviewer can walk from spec to code.
- **"What the code does," not "what it should do"** — the spec describes current behaviour. Aspirational changes go through normal PR review, not spec edits.
- **Cross-references** — if behaviour depends on another area (e.g. skip-permissions interacts with tool-allowlisting), note it in an "Interaction" subsection rather than duplicating.
