# Agents, Bindings, Templates, Icons

## Feature: Agents, Bindings, Templates, Icons

### Intended Behavior

**Agent Definitions** (`agents.ts`) represent reusable, portable Claude-powered assistant configurations stored as YAML files matching the Claude Managed Agents API schema with dc-specific `x-dc-*` extensions. Multiple chat bindings can reference the same agent definition, enabling shared behavior across chats.

**Bindings** (`bindings.ts`) link a Delta Chat group to an agent definition and hold runtime state: the agent ID, Claude session UUID (for `--resume` terminal resumption), the `inheritClaudeMd` flag (whether to include CLAUDE.md in the subagent context), and the working directory where the subagent spawns. A binding may exist without an `agentId` (e.g., a chat whose first subagent spawned before setup completed); in that case the subagent runs with defaults and the binding gets populated once the user finishes setup.

**Templates** (`templates.ts`) are pre-configured agent drafts shipped in `plugin/templates/*.yaml`, marked with an `x-dc-template` metadata block describing picker category, UI description, and required MCP server dependencies. The picker instantiates templates into fresh DraftAgent objects (stripped of template metadata and id), ready for the user to customize.

**Icons** (`agent-icon-render.ts`) render 256×256 PNG badge images: a Lucide glyph (vendored in `agent-icons/glyphs/*.svg`) centered in a circular badge with model-family color background. Trust state (skip-permissions flag set) adds a two-tone checker pattern. The renderer is called with archetype, model family, trust flag, and glyph name; it outputs a cached PNG key-hashed by those inputs. A prebuilt directory (`agent-badges-prebuilt/`) supplies common combinations; missing files are rendered on-the-fly.

**Import/Export** (`server.ts`, `tryImportAgentAttachment`): When a `.yaml` or `.yml` file is sent to a chat, the dispatcher intercepts it, parses it as an agent definition, resolves collisions by suffixing `-2`, `-3`, etc., persists it, and sends a confirmation. Rejected files (parse error, validation failure, >256 KB) receive error feedback. The import is **not transactional** — if persistence succeeds but notification fails, the agent is saved anyway.

### State Machine / Transitions

**Agent Lifecycle:**
1. **Template** → instantiated as a DraftAgent (id-less, template metadata stripped).
2. **Created** → user edits the draft and saves; id is synthesized from name (collision-resolved); YAML file written to disk.
3. **Edited** → name, model, prompt, metadata (glyph, icon, archetype, skip-permissions) updated in-place; file rewritten atomically.
4. **Imported** → YAML attachment is parsed, id collision-resolved, and saved (may trigger `idChanged` flag to user).
5. **Deleted** → file removed (disallowed for built-in `claude-code` agent); any chats bound to it become orphaned but keep their binding records.

**Binding Lifecycle:**
1. **Created** → auto-created on first message in a chat (minimal binding, no agentId); or populated via agent setup UI with full binding (agentId + inheritClaudeMd).
2. **Updated** → agent rebinding (user picks a different agent); metadata preserved (sessionId, workingDir, createdAt).
3. **Deleted** → happens when a chat is left/deleted (unpairing); orphaned binding files may linger on disk until `sweepOrphans()` is called (once per dispatcher startup).
4. **Cascade on Agent Delete** → **no automatic cascade**. Bindings pointing to a deleted agent remain on disk but `resolveChat()` returns null. The UI must detect orphaned chats separately.

**Import State Transitions:**
1. **Validate** → schema parse (Zod); unknown model IDs rejected.
2. **Resolve Collision** → if id provided and exists, append `-2`, `-3`, etc.; set `idChanged` flag.
3. **Persist** → atomic write to `agents/<agentId>.yaml` via temp + rename.
4. **Notify** → send success or error message to chat; return true (handled).

### Persisted State

All directories live under `~/.claude/channels/deltachat/`:

- **`agents/<agentId>.yaml`** — Agent definition file (Zod-validated YAML). Each file contains a complete AgentDef: id, name, model, description, system prompt, tools array, optional skills/mcp_servers/metadata. Example: `coach.yaml`.

- **`bindings/<chatId>.json`** — Binding record (Zod-validated JSON). Schema:
  ```json
  { "chatId": 12345, "agentId": "coach", "sessionId": "uuid",
    "inheritClaudeMd": false, "workingDir": "/path", "createdAt": "ISO8601" }
  ```

- **`approved/<chatId>`** — Pairing access record (simple file marker). Contains the owner's contact ID or is empty (legacy). Used by `access.isAllowed(chatId)`.

- **`session-agents.json`** — Reverse index (plain JSON object `{ sessionId: agentId }`). Survives binding deletion so terminal sessions can recover the original agent on resume. Example: `{ "uuid-1": "coach", "uuid-2": "developer" }`.

- **`agent-badges/<hash>.png`** — PNG cache. Key format: `{archetype}-{modelFamily}-{trust}-{glyph}.png` (e.g., `role-sonnet-plain-user-round.png`). If missing, renderer synthesizes and caches it.

- **`agent-icons/glyphs/`** — Vendored Lucide SVG files (read-only, not created by runtime). New glyphs must be added manually.

- **`agent-icons/palettes.ts`** — Curated glyph palettes per archetype and model-family colors (source configuration, not a file on disk). Changes require code recompile.

- **`templates/`** — Built-in template YAML files (read-only). Loaded once at startup by `listTemplates()`.

### Observable Surface

**Agent Metadata Keys** (x-dc-* standard extensions):
- `x-dc-archetype` — One of `role`, `utility`, `project`; defaults to `role`. Drives default icon glyph.
- `x-dc-icon` — Explicit emoji/icon override (e.g., `"🧭"`). Falls back to archetype default if unset or empty.
- `x-dc-glyph` — Lucide glyph name (e.g., `"cog"`, `"user-round"`). Must be in the archetype's curated palette; invalid names silently fall back to archetype default. Paired with a model-family color to render the badge.
- `x-dc-skipPermissions` — Boolean. When `true`, subagent tool calls are auto-approved (no permission prompts). Stored only when true; absent means false.
- `x-dc-iconMirror` — Boolean. When `true`, the chat profile image uses the horizontally-flipped glyph variant. Stored only when true.
- `x-dc-template` — Block of template metadata (category, description, requires). **Not transferred to user agents** — stripped on instantiate.
- `x-dc-createdAt` — ISO 8601 timestamp (when the agent definition was created).

**YAML Import Contract:**
- **Accepted Extensions:** `.yaml`, `.yml` (case-insensitive)
- **Max Size:** 256 KB (file or parsed UTF-8 string, whichever is larger)
- **Schema:** Must match `AgentDefSchema` (id optional, name required, model must be in `ALLOWED_MODELS`)
- **ID Synthesis:** If `id` is absent, derived from `name` via `slugifyName` → collision-resolved with `-2`, `-3` suffix logic.
- **ID Collision Resolution:** If provided or synthesized id exists, append numeric suffixes (first available); set `idChanged` flag in result.
- **Rejection Reasons:** YAML parse error, schema validation failure (unknown model, missing name, invalid id format), file too large, non-UTF-8 encoding.
- **Success Response:** `✅ Imported agent "{name}" {idChanged note}. To create a chat with it, use the agent setup card.`
- **Error Response:** `⚠️ Couldn't import agent from "{filename}": {error}` (truncated to 200 chars for DC message length limits).

**Icon Rendering Cache:**
- **Input Keys:** `(archetype, modelFamily, trust, glyph)` → deterministic cache key `{archetype}-{modelFamily}-{trust}-{glyph}.png`.
- **Cache Invalidation:** None. Prebuilt files are immutable; runtime-rendered PNGs persist in `agent-badges/` until manual deletion. If palette colors or glyph SVG content changes, old cached files are orphaned (no auto-cleanup, must manual-delete `agent-badges/`).
- **Prebuilt Fallback:** Environment variable `DC_SKIP_PREBUILT=1` disables prebuilt lookup (forces render); otherwise missing prebuilt files are copied to cache on first hit.

**Default Agent:**
- Sentinel id `claude-code` is the undeletable built-in default. `deleteAgent("claude-code")` throws. `ensureDefaultAgent()` auto-seeded on startup.
- Name, model, prompt, metadata are user-editable; existence and id are immutable.

### Primary Source Files

| File | Purpose |
|------|---------|
| `plugin/agents.ts` | AgentDef YAML registry; id/name collision resolution; archetype/icon/glyph/skip-permissions metadata accessors |
| `plugin/bindings.ts` | Binding JSON store; session UUID management; agent resolution; orphan sweep for unpaired chats |
| `plugin/session-agents.ts` | Persistent sessionId → agentId reverse index; survives binding deletion; used for terminal resume |
| `plugin/templates.ts` | Template YAML loader; instantiate draft agents; Template view for picker UI |
| `plugin/agent-icon-render.ts` | Badge PNG renderer (Lucide glyph + model color); prebuilt fallback; file cache |
| `plugin/agent-setup-glyphs.ts` | Compile-time Lucide SVG inner-XML loader for WebXDC badge preview |
| `plugin/agent-icons/palettes.ts` | Curated glyph palettes per archetype; model family colors (solid + checker) |
| `plugin/agent-icons/glyphs/*.svg` | Vendored Lucide SVG files (read-only) |
| `plugin/agent-setup.ts` | WebXDC app builder; splices glyph map into HTML at build time |
| `plugin/server.ts` (`tryImportAgentAttachment`) | YAML attachment interception; collision-resolved import; user feedback |
| `plugin/models.ts` | Model list, tier-based system prompts, inheritClaudeMd policy |
| `plugin/access.ts` | Pairing/approval state; used by `bindings.countByAgentId` and `sweepOrphans` |

### Audit Notes

**Stale Bindings:** When a chat is left/deleted (unpairing), the binding file lingers on disk. `bindings.sweepOrphans()` (called once at dispatcher startup) removes files whose chatId is no longer in the access list. However, **between startup and the sweep, invalid bindings may be found and cause null-pointer issues** if code assumes `resolveChat()` always succeeds for a bound chat.

**Orphaned Agents:** When an agent definition is deleted via `deleteAgent()`, no cascade happens. Bindings still point to the deleted agentId; `resolveChat()` returns null. The UI must detect this and show a "missing agent" state. No automatic rebinding or migration.

**Icon Cache Invalidation:** When palette colors are tweaked in `palettes.ts` or glyph SVG content changes, existing cached PNG files remain unchanged (no invalidation mechanism). Old files are orphaned in `agent-badges/`. Manual deletion required; no TTL or version tracking.

**Glyph Palette Mismatch:** If an agent has `x-dc-glyph: invalid-name` (outside its archetype palette), the renderer silently falls back to the default glyph without warning. User is unaware their custom glyph was ignored.

**Missing Agent Definition:** If a binding exists but the referenced agent file is deleted, `resolveChat()` returns null. No warning is logged at load time; error only surfaces when that chat tries to spawn a subagent.

**Model Migration:** If a model ID is removed from `ALLOWED_MODELS` (e.g., deprecated model sunsetted), existing agents with that model cannot be edited (validation fails). They remain on disk but are "stuck" — no way to upgrade without manual YAML editing.

**ID Collision on Import:** Collision resolution appends `-2`, `-3` suffixes, but this can create confusing IDs. Example: importing `coach.yaml` twice yields `coach` and `coach-2`. No deduplication of intent (both might be identical copies).

**Session-Agents Staleness:** If a binding is deleted but the session is still active (resuming in terminal), `session-agents.json` still has the mapping. Resume works correctly, but old entries accumulate over time (no cleanup on binding delete).

**Agent Metadata Pollution:** User can manually edit YAML files (advanced use case) and insert unknown `x-dc-*` keys. Unknown metadata passes schema validation (metadata is `Record<string, unknown>`) and is preserved but ignored by the runtime. No schema validation of metadata keys.

**Skip-Permissions Leakage:** An agent with `x-dc-skipPermissions: true` auto-approves tool calls. If a user exports this agent YAML and shares it, the recipient receives an agent with this flag intact. No audit trail or warning on import.

**Atomic Write Vulnerability:** Agent and binding save operations use atomic temp + rename, but in high-contention scenarios (concurrent saves to the same file), last-writer-wins. If two processes both update the same agent, one update is silently lost.

**Icon Mirror Inconsistency:** The `x-dc-iconMirror` flag affects the chat profile image but is not reflected in the badge renderer (`agent-icon-render.ts`). The actual glyph is never flipped in previews or notifications — only the final Delta Chat profile image flips it (external client rendering).
