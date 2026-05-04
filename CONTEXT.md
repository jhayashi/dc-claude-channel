# dc-claude-channel domain glossary

The vocabulary of this codebase. Use these terms exactly when discussing the system, naming variables, or proposing changes. Drift erodes the value — if a new concept emerges that isn't here, add it.

This file is **living**: extend it whenever a session sharpens a fuzzy term, names a new module, or surfaces a load-bearing distinction. The bar for inclusion is "a term that, if not in the glossary, would force a paragraph of explanation each time it's used."

For longer-form architecture documentation, see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Process and dispatch

**Dispatcher** — The single `bun server.ts` process. Owns the DC RPC connection, the MCP server (tools-proxy over a Unix socket), and the subagent LRU cache. One per Delta Chat account.

**Subagent** — A persistent `claude -p` child process bound to one chat. Receives DC messages as user turns over its stdin (stream-json) and emits assistant turns. Cached LRU (default 8 active, 15 min idle).

**Turn** — One user message → assistant loop of N tool calls → final assistant text. A long task is typically one turn with many tool calls inside, not many turns.

**Cold spawn** — Starting a subagent process from scratch with `--resume <sessionId>` to rehydrate prior turn history. Costs ~10s of latency.

**Tools proxy** — The MCP server the dispatcher exposes to subagents over a Unix socket. Every `dc_*` tool call from a subagent goes through this proxy.

---

## Identity and trust

**Agent definition** — Reusable role description authored as YAML at `~/.claude/channels/deltachat/agents/<id>.yaml`. Holds name, model, system prompt, allowed tools, etc. One agent definition can be bound to many chats over time.

**Binding** — Per-chat record at `bindings/<chatId>.json` linking the chat to an agent definition + claude session UUID for `--resume`. Bindings are not reusable across chats; agent definitions are.

**Principal** — Per-contact identity record at `principals/humans/<contactId>.json`. The source of truth for "is this contact trusted to interact with the bot." A principal record exists once a contact has paired; it persists across chats.

**Trust filter** — The dispatcher's gate between DC's full-fidelity local DB and the subagent's context window. Tags every inbound line as `[permissioned]` or `[UNPERMISSIONED]`; lives in `plugin/dispatcher/trust-filter.ts`.

**Permissioned content** — A message whose sender has a principal record. Subagents see permissioned content directly; unpermissioned content is redacted unless the subagent explicitly opts in.

**Capability** — Token-based authorization for cross-contact tool calls (#71, v1.3). A capability says "this contact may invoke this tool." Replaces and refines the older "is the chat owner" check.

**Pairing** — The QR / verification ceremony that creates a principal record. Two paths today: securejoin (DC's native verification) and the agent-setup wall (in-app code exchange).

**Auto-pair** — When a contact who already has a principal record sends in a *new* chat with the bot, the dispatcher silently approves the chat without re-running the ceremony. The trust boundary is contact identity, not chatId.

**Skip-permissions mode** — Per-binding flag that bypasses the permissions WebXDC card for tool calls. Sometimes called "trusted mode."

---

## Agent creation

**Wall** — The first-message-in-a-new-chat exchange that pairs a contact and lets them pick / build an agent. Implemented in the agent-setup WebXDC.

**Coach** — The interview phase of agent creation. The coach asks the user about their needs and proposes a concrete agent definition.

**Leaf** — Atomic unit in the agent-creation catalog at `plugin/leaves/<id>.yaml`. Each leaf describes a specialty (e.g., `personal-attorney`, `family-meal-planner-cook`) with a name, pitch, expertise, liability flag, suggested tools, and combinesWith pointers.

**Path** — Top-level category a leaf belongs to: `Expert`, `Service`, or `Goal`. Drives layout in the catalog and defaults in the coach.

**combinesWith** — Authored one-way pointer from a leaf to other leaves it pairs naturally with. The catalog loader computes the symmetric closure at runtime so two-way navigation works.

**suggestedTools** — Per-leaf list of MCP servers / tool identifiers the leaf wants enabled when it's part of an agent. Schema field exists today; population is incomplete (see #74).

---

## WebXDC apps

**WebXDC app** — A self-contained `.xdc` HTML file the dispatcher sends into a chat. Has a sandboxed runtime; communicates with the dispatcher via `sendUpdate` payloads.

**Familiar** — A WebXDC app with server-side state and a sandboxed handler JS string. Distinguished from a static WebXDC by `requestLLM`, persistent `ctx.state`, and `ctx.sendUpdate`.

**Auto-upgrade protocol** — The contract every WebXDC app implements: detect a version mismatch on receipt and reload. Required so users on stale clients pick up new app versions without manual reinstall.

**App version** — A monotonic version number embedded in each WebXDC's HTML. Bumped on every change; the auto-upgrade protocol triggers on mismatch.

**Permission card** — The WebXDC app shown when a non-trusted subagent requests a tool that requires user approval. One per pending permission request.

**Agent-setup card** — The WebXDC app for agent management: create, switch, edit, delete, resume terminal sessions, teleport to terminal.

**File reviewer** — The WebXDC app for displaying long-form markdown / code with inline commenting.

---

## State and storage

**Channel state dir** — `~/.claude/channels/deltachat/`. Contains `agents/`, `bindings/`, `principals/`, `approved/`, `events/`, `schedules/`, `dc-data/`, etc.

**Approved chats** — Legacy per-chat allowlist at `approved/<chatId>`. Still consulted as a fallback gate during the v1.2 → v1.3 transition; v1.3 derives the allowlist from principals + chat membership instead.

**Event logs** — Four append-only NDJSON streams under `events/`: `tools-*.log`, `turns-*.log`, `permissions-*.log`, `webxdc-*.log`. Surfaced via the `dc_show_events` tool.

**Schedules** — Persistent cron-style jobs at `schedules/<jobId>.json`. Created via `dc_schedule*`; runs deliver synthetic user turns to the target chat's subagent.

**Auto-memory** — Filesystem-based memory at `~/.claude/projects/<cwd-hash>/memory/` with a `MEMORY.md` index and per-fact files. Shared across the dispatcher and all subagents because they share the working directory. Per-agent isolation is being added (#81).

---

## Architecture vocabulary (Ousterhout)

These are the architectural terms used in design discussions, ADR rationale, and the `improve-architecture` skill. Originating in *A Philosophy of Software Design*; not specific to this codebase, but use them consistently.

**Module** — Anything with an interface and an implementation. Function, class, package, file, slice.

**Interface** — Everything a caller must know to use the module: types, invariants, error modes, ordering constraints, config. Not just the type signature.

**Implementation** — The code inside.

**Depth** — Leverage at the interface. *Deep* = a lot of behavior behind a small interface. *Shallow* = interface nearly as complex as the implementation.

**Seam** — Where an interface lives. A place behavior can be altered without editing in place. (Use this, not "boundary.")

**Adapter** — A concrete thing satisfying an interface at a seam.

**Leverage** — What callers get from depth.

**Locality** — What maintainers get from depth: change, bugs, knowledge concentrated in one place.

**Deletion test** — Imagine deleting the module. If complexity vanishes, it was a pass-through. If complexity reappears across N callers, it was earning its keep.
