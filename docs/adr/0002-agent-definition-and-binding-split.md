# ADR-0002: Agent definition / binding split

**Status:** Accepted
**Date:** 2026-04-15 (backfilled 2026-05-01)

## Context

Each chat needs to know which agent it's running and which Claude session UUID to resume. Two natural ways to model this:

1. **Unified record.** One file per chat holding agent role + session UUID + per-chat overrides.
2. **Split: agent definition + binding.** Agent definition is a reusable role; binding is a per-chat pointer to the agent plus the session UUID.

The pull toward unification: simpler mental model, one place to look. The pull toward split: agents are inherently reusable across chats (a "personal attorney" agent serves many chat threads), and editing the role to fix a bug or add a tool should propagate to every chat that uses it.

## Decision

Split into two records:

- **Agent definition** at `~/.claude/channels/deltachat/agents/<id>.yaml` — name, model, system prompt, allowed tools. Reusable across chats.
- **Binding** at `bindings/<chatId>.json` — `{ agentId, sessionId, inheritClaudeMd, createdAt }`. One per chat.

Editing an agent definition mutates in place; the next turn in every bound chat picks up the change. Bindings are not portable across chats.

## Consequences

**Benefits.**

- A single edit to an agent role propagates to every chat that uses it. No N-chat migration.
- Sharing/exporting an agent is trivial — copy the YAML.
- Per-chat state (session UUID, claude.md inheritance flag, future per-chat overrides) lives in the binding without polluting the agent record.
- Agents-as-templates: import a community-authored agent without inheriting someone else's session state.

**Costs.**

- Two records to keep consistent. A binding's `agentId` can become dangling if the agent definition is deleted; cleanup logic has to handle that.
- Per-chat overrides (e.g., a model override for one specific chat) require a third concept (binding-level override field) rather than just editing "the chat's record."
- Two files to load per turn instead of one. Negligible at current scale; worth flagging.

**Rejected alternatives.**

- *Unified record per chat.* Rejected: would force N-way duplication of agent role text and force re-authoring the role to update behavior across chats. Every "fix the system prompt" task would become a migration.
- *Agent record contains a list of bound chatIds.* Rejected: makes the agent record mutate on every new chat creation, complicating optimistic locking and making "is this agent in use" queries non-local.

## Related

- Agent rebinding (#54) extends this model with the ability to change `agentId` on an existing binding.
- Per-agent memory (#81) builds on top: agent-level memory dirs are keyed by `agentId`, so memory survives across chats that bind the same agent.
