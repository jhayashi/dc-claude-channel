# D4C Concept Mapping: Terminology Recommendations

## The problem

Three systems contribute concepts that users must internalize:

| Delta Chat | Claude Code / Anthropic | D4C (our glue) |
|---|---|---|
| Contact | — | The bot |
| Group chat (icon, description, members) | — | The container |
| 1:1 chat | — | Pairing channel |
| — | Agent (name, model, prompt, tools) | The personality |
| — | Session (conversation history, resumable) | The memory |
| — | Permission mode | Trust level |
| — | Model (Opus, Sonnet, Haiku) | Capability tier |
| — | MCP servers, built-in tools | Capabilities |
| Chat binding + session UUID | — | Implementation detail |

The user currently has to hold ~8 concepts to understand what's going on. We need to collapse these into as few user-facing concepts as possible, anchored on Anthropic terminology for forward compatibility.

---

## What the user actually does

1. **Creates something** (a chat? an agent? both?)
2. **Configures it** (model, prompt, tools, permissions)
3. **Talks to it** (sends messages, gets responses)
4. **Manages it** (edits config, archives, deletes, reuses)

Steps 2–4 are straightforward UX. Step 1 is where the terminology confusion lives: *what are they creating?*

---

## Recommendation: Agent-first

**Core concept: "Agent"**

The user creates an **agent**. An agent has a name, icon, model, prompt, tools, and trust level. When you create an agent, it gets a chat. The chat is *where you talk to the agent* — it's not a separate thing to understand.

| User says | What happens |
|---|---|
| "Create an agent" | Agent YAML created + group chat created + binding written |
| "Edit the agent" | Agent YAML updated (all chats using it pick up changes) |
| "New chat with this agent" | New group chat + new binding to same agent |
| "Delete this agent" | Agent YAML deleted + all bound chats cleaned up |
| "Archive this chat" | Chat archived, agent definition preserved for reuse |

### Terminology mapping

- **Agent** = name + model + prompt + tools + trust level (the Anthropic concept, extended with D4C's trust level)
- **Chat** = the Delta Chat group where you talk to the agent (just the container — users already understand "chat")
- **Session** = hidden. The user never sees session UUIDs. "Pick up where I left off" is automatic. Teleport exposes it as an advanced feature but frames it as "take this conversation with you."

### What disappears from user vocabulary

- "Binding" — never surfaces. It's plumbing.
- "Subagent" / "process" — internal. The user has "a chat with an agent."
- "Permission mode" → becomes "trust level" or just "permissions" (a toggle on the agent: trusted vs. supervised)
- "Model" stays (it's Anthropic terminology), but is a property of the agent, not a standalone concept.

### Why agent-first

- Aligns with Anthropic's Managed Agents direction — "agent" is the durable concept.
- Fewest user-facing concepts: **agent** (the thing) + **chat** (where you talk to it). Everything else is a property of the agent.
- Natural language: "my coding agent," "my email agent," "the baseball agent."
- One-to-many is intuitive: "I have two chats with the coding agent" makes sense the way "I have two chats with Alice" makes sense.

### Key refinement: implicit chat creation

Make the **chat creation implicit**. The user never has to think about "creating a chat" separately — creating an agent (or picking one) always produces a chat. The mental model is:

> **"Each chat has an agent. You pick (or create) the agent, and you get a chat."**

---

## The five user-facing concepts

1. **Agent** — who you're talking to (name, icon, model, prompt, tools, trust level). Anthropic's term. Reusable, exportable, shareable.
2. **Chat** — where you talk to the agent. Delta Chat's term. One agent can have multiple chats. Each chat has its own conversation history.
3. **Model** — the agent's brain (Opus, Sonnet, Haiku). Anthropic's term. A property of the agent.
4. **Tools** — what the agent can do (read files, run commands, check email, etc.). Anthropic's term. A property of the agent.
5. **Trust level** — whether you review every action (supervised) or let the agent run free (trusted). D4C's term, but maps to Anthropic's permission concepts.

That's it. Five concepts, three from Anthropic, one from Delta Chat, one from D4C. Everything else (binding, session, subagent, MCP server, skip-permissions, session UUID) is implementation detail that never surfaces in the UI or docs.

---

## Terminology cheat sheet for the codebase and UI

| Internal term | User-facing term | Notes |
|---|---|---|
| Agent definition (YAML) | **Agent** | "Create an agent," "edit this agent" |
| Binding | *(hidden)* | Never shown. "This chat uses the X agent" is enough. |
| Session UUID | *(hidden)* | "Conversation history" if it ever surfaces. Teleport can say "resume this conversation." |
| Skip-permissions | **Trusted** / **Supervised** | Binary toggle. "This agent is trusted" vs "This agent asks before acting." |
| Subagent process | *(hidden)* | "The agent" from the user's perspective. |
| MCP servers | **Connected services** or just **Tools** | "Gmail," "Calendar," "Slack" — listed alongside built-in tools. |
| `allowedBuiltinTools` | **Permissions** or **Allowed tools** | Part of the agent's tool configuration. |
| Chat icon | **Agent icon** | Set on the agent, applied to all its chats. |
| Chat description | **Agent description** | Or just the agent's prompt summary. |

---

## What changes in the UI

1. **Setup card** — rename from "Agent Setup" to just "Agents." Primary flow: pick or create an agent → chat is created automatically.
2. **Chat list** — each chat shows the agent's name and icon. The Delta Chat group name IS the agent name (or "Agent Name — Chat 2" for multi-chat agents).
3. **README / docs** — lead with "agent" terminology everywhere. "Create an agent" not "create a group chat." "Your coding agent" not "your coding chat."
4. **Teleport** — "Resume this agent's conversation in your terminal" / "Import a terminal session into this agent."

---

## Open question: what do we call the 1:1 pairing chat?

This doesn't fit the agent model cleanly (it's a handshake channel, not an agent conversation). Options:
- **"D4C Setup"** — a system chat that exists for pairing and maintenance.
- Phase it out entirely per #53 (move tutorial to a group chat, use the 1:1 only for initial pairing, then archive).
- Or: bind it to a default agent and treat it like any other chat. Simplest, but the 1:1 vs group behavioral differences make this messy.

---

## Alternatives considered

### Option B: Chat-first

The user creates a **chat**. A chat has a personality (model, prompt, tools, trust). The agent definition is hidden — it's just "chat settings."

**Pros:** Lowest learning curve. Maps directly to Delta Chat's UI.
**Cons:** Diverges from Anthropic terminology. The one-to-many relationship is confusing ("two chats with the same settings" is less intuitive than "two chats with the same agent"). Loses the narrative power of "agents." People want agents, not chat settings.

### Option C: Hybrid — "Agent Chat"

A compound noun. You create an "agent chat." Configuration is per-chat. Reuse is "clone this agent chat."

**Pros:** Single compound concept.
**Cons:** Awkward as a noun. Doesn't survive one-to-many well. Still diverges from Anthropic terminology.
