/**
 * Agent-flow shared helpers. Formerly the agent-setup WebXDC monolith;
 * the card itself (its screens, the init sender, and the open tool) was
 * retired in increment 4 (#109) when its flows were peeled into the
 * standalone create-agent and agent-manage cards. This module now holds
 * only the shared surface those cards + server.ts + the coach machinery
 * import: the create/build/graduate flow, the §6-gated manage/edit/reuse/
 * rebind handlers, and the agent-chat decoration + naming helpers.
 *
 * (Optional follow-up, deferred: rename this file to agent-flows.ts.)
 */

import type { AppContext } from '../webxdc-app.js'
import { getAgentManageVersion } from '../agent-manage.js'
import * as agents from '../agents.js'
import * as models from '../models.js'
import * as bindings from '../bindings.js'
import * as access from '../access/index.js'
import { loadAllLeaves, symmetricCombines, getDefaultCatalog, type Catalog, type Leaf, type Path } from '../leaves.js'
import { ALL_BUILTIN_TOOLS, BUILTIN_TOOL_DESCRIPTIONS } from '../dispatcher/subagent-process.js'
import { startCoach, advanceCoach, isCoachDone, collectAnswers, type CoachState, type CoachAnswers } from '../coach.js'
import { assembleSystemPrompt } from '../prompt-assembler.js'
import { type PatternId } from '../agent-icons/palettes.js'
import { logLifecycleEvent } from '../events-lifecycle.js'
import * as sessionAgents from '../session-agents.js'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export function availableToolsPayload(ctx: AppContext) {
  return {
    availableBuiltinTools: ALL_BUILTIN_TOOLS.map(name => ({
      name,
      description: BUILTIN_TOOL_DESCRIPTIONS[name] ?? '',
    })),
    availableMcpServers: ctx.getAvailableMcpServers(),
    connectedMcpServers: ctx.getConnectedMcpServers(),
  }
}

/**
 * Adapter between the v1.4 AgentDef schema (in-memory) and the v1.3
 * WebXDC form payload (which the agent-setup HTML still speaks). The
 * full form rewrite is Slice 6; until then translate at the boundary.
 *
 * Splits the new `tools` CSV back into the legacy parallel allowlists
 * (allowedBuiltinTools + allowedMcpServers) the form expects.
 */
function splitToolsCsv(tools: string): { allowedBuiltinTools: string[]; allowedMcpServers: string[] } {
  const parts = tools.split(',').map(s => s.trim()).filter(Boolean)
  const allowedBuiltinTools: string[] = []
  const mcpServers = new Set<string>()
  for (const t of parts) {
    if (t.startsWith('mcp__')) {
      // Take the server segment (the substring before any second __).
      const rest = t.slice(5)
      const sep = rest.indexOf('__')
      mcpServers.add(sep < 0 ? rest : rest.slice(0, sep))
    } else {
      allowedBuiltinTools.push(t)
    }
  }
  return { allowedBuiltinTools, allowedMcpServers: [...mcpServers] }
}

/**
 * Resolve the human-friendly name for an agent. Prefers the explicit
 * `x-dc-display-name` (if set), otherwise falls back to the agent's
 * slug `name`. Used wherever the agent is surfaced in chat UI.
 */
function agentDisplayName(agent: agents.AgentDef): string {
  const explicit = agent['x-dc-display-name']
  return typeof explicit === 'string' && explicit.length > 0 ? explicit : agent.name
}

/**
 * Build the legacy WebXDC form payload from a v1.4 AgentDef. Used by the
 * "edit existing agent" handler when sending the draft to the card.
 */
function legacyDraftFromAgent(agent: agents.AgentDef): Record<string, unknown> {
  const { allowedBuiltinTools, allowedMcpServers } = splitToolsCsv(agent.tools ?? '')
  return {
    id: agent.name,
    name: agent['x-dc-display-name'] ?? agent.name,
    model: agent.model,
    system: agent.body,
    tools: [],
    skipPermissions: agents.getSkipPermissions(agent),
    memoryBoost: agents.memoryBoostEnabled(agent),
    iconMirror: agents.getIconMirror(agent),
    archetype: agents.getArchetype(agent),
    icon: agents.iconForAgent(agent),
    explicitIcon: agents.getExplicitIcon(agent),
    glyph: agents.glyphForAgent(agent),
    pattern: agents.patternForAgent(agent),
    effort: agent.effort,
    allowedBuiltinTools,
    allowedMcpServers,
  }
}

/**
 * Per-L2 summary for the new-agent-flow wall: one entry per distinct
 * `l2` group, with leaf count and up to 3 sample names. Server-side so
 * the WebXDC card doesn't have to re-iterate the full leaf catalog to
 * render the tile grid.
 */
interface L2Summary {
  path: Path
  l2: string
  count: number
  sample: string[]
}

export function buildL2Summary(leaves: Leaf[]): L2Summary[] {
  const map = new Map<string, L2Summary>()
  for (const l of leaves) {
    if (!map.has(l.l2)) {
      map.set(l.l2, { path: l.path, l2: l.l2, count: 0, sample: [] })
    }
    const e = map.get(l.l2)!
    e.count++
    if (e.sample.length < 3) e.sample.push(l.name)
  }
  return [...map.values()]
}

export interface Session {
  msgId: number
  sourceChatId: number
  lastSerial?: number
  needsSerialSeed?: boolean
  /**
   * Snapshot of the card HTML's APP_VERSION at the time the card was sent
   * to this chat, used to decide whether the existing card is current.
   * Pre-2026-05-31 sessions don't have this field (undefined), which
   * shouldResendCard treats as stale so the user lands on the fresh HTML
   * immediately instead of going through the version_mismatch round-trip.
   *
   * NOTE (increment 4): the agent-setup monolith that used this Session
   * type at runtime is retired. `Session` / `shouldResendCard` /
   * `parseSessions` are kept as pure, unit-tested helpers.
   */
  appVersion?: number
}

/**
 * Decide whether a card opener should send a *new* xdc card to the chat,
 * or just push a status update to the existing one.
 *
 * Reusing a stale card forces the user through the version_mismatch flow
 * after a release: their old card detects the higher server version, fires
 * version_mismatch, the dispatcher re-spawns a fresh card, and the user
 * sees the "outdated, upgrading…" UI flash on the old card. Tracking
 * appVersion per session and only reusing on an exact match avoids that.
 *
 * Reuse rules:
 *   - No existing session              → send new (true)
 *   - existing.appVersion === current  → reuse (false)
 *   - existing.appVersion is undefined → send new (true) — legacy
 *   - any other mismatch (number/string/NaN) → send new (true)
 */
export function shouldResendCard(
  existing: Session | undefined,
  currentVersion: number,
): boolean {
  if (!existing) return true
  if (typeof existing.appVersion !== 'number') return true
  return existing.appVersion !== currentVersion
}

/**
 * Pure parser for the legacy sessions-on-disk JSON. Kept unit-tested
 * without a real filesystem; the monolith load path that consumed it is
 * retired (increment 4). Returns an empty array on malformed/missing/
 * non-array input — never throws.
 *
 * Validates each entry shape:
 *   - msgId, sourceChatId: required, must be numbers
 *   - appVersion: optional, only kept if it's a number (string/NaN
 *     are dropped to undefined so === comparisons stay safe)
 *   - lastSerial: optional, only kept if it's a number
 */
export function parseSessions(raw: string): Session[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: Session[] = []
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    if (typeof e.msgId !== 'number' || typeof e.sourceChatId !== 'number') continue
    const session: Session = {
      msgId: e.msgId,
      sourceChatId: e.sourceChatId,
    }
    if (typeof e.lastSerial === 'number') session.lastSerial = e.lastSerial
    if (typeof e.appVersion === 'number') session.appVersion = e.appVersion
    out.push(session)
  }
  return out
}

/**
 * Build the tools CSV from the agent-setup form's submission. Encodes the
 * client protocol of `collectCreateToolPickerState`:
 *
 *   - `null` / `undefined` → ALL boxes in that category were checked, i.e.
 *     the user accepted the picker's default offering. Server-side that
 *     expands back to the full universe the picker showed (built-ins =
 *     `ALL_BUILTIN_TOOLS`). Conservative on MCP servers: the picker shows
 *     curated + connected servers, and silently auto-attaching all of
 *     them (Slack/Gmail/etc.) to every new agent is too invasive; the
 *     user has to explicitly check them to opt in, so `null` MCP servers
 *     yields no MCP servers in the CSV. `mcp__dc` is added downstream by
 *     `saveAgent`'s `ensureMcpDc`, so it's not included here.
 *   - explicit empty array (`[]`) → user un-checked every box → literally
 *     no entries in that category.
 *   - explicit non-empty array → only those entries.
 *
 * This corrects the pre-2026-05-31 bug where the create handler did
 * `?? []` and treated client-sent `null` ("all checked") as empty, so
 * new agents from the + Create new agent form ended up with no built-in
 * tools (Joe noticed 2026-05-30).
 */
export function buildCreateAgentToolsCsv(
  allowedBuiltinTools: string[] | null | undefined,
  allowedMcpServers: string[] | null | undefined,
): string {
  const builtins = (allowedBuiltinTools === null || allowedBuiltinTools === undefined)
    ? ALL_BUILTIN_TOOLS
    : allowedBuiltinTools
  const mcp = (allowedMcpServers ?? []).map(s => `mcp__${s}`)
  return [...builtins, ...mcp].join(', ')
}

/**
 * Decide the x-dc-memory-boost value for a newly-created agent. The card's
 * explicit switch value wins when supplied; otherwise fall back to the
 * creation classifier (the zero-config default for non-card callers like the
 * dc_create_agent tool). Returns the on/off string stored in frontmatter.
 */
export function resolveMemoryBoost(explicit: boolean | undefined, body: string): 'on' | 'off' {
  if (typeof explicit === 'boolean') return explicit ? 'on' : 'off'
  return agents.classifyMemoryBoost(body)
}

/**
 * Per-chat coach interview state. Populated when the user taps "Build now"
 * on the new-agent wall (`build-agent` payload), torn down when the coach
 * finishes and the chat graduates to a real agent. The dispatcher reads
 * this map BEFORE running normal subagent dispatch — see runSubagentTurn.
 *
 * In-memory only on purpose: a coach interview is a short interactive
 * dialog the user runs to completion in one sitting. If the dispatcher
 * restarts mid-coach, falling back to the (already-existing) bare DC
 * chat without an agent is acceptable — the user can just re-open the
 * setup card and try again.
 */
export interface CoachSession {
  coachState: CoachState
  leafIds: string[]
  /** Claude session UUID. Required for build-new sessions (persisted into
   *  the new binding so the subagent's first --resume hits the same
   *  on-disk .jsonl). Refine sessions don't need it — they're acting on
   *  an already-bound chat whose session is owned by the existing
   *  binding — so leave it undefined for those. */
  sessionId?: string
  /** Badge pattern picked by the user on the review screen (Phase 9.2).
   *  Validated against PATTERN_IDS at intake; fallback to 'checker' if
   *  the client sent an unknown id. Written to metadata['x-dc-pattern']
   *  by graduateAgent. Optional because Refine sessions reuse the
   *  existing agent's pattern — no new badge to pick. */
  pattern?: PatternId
  /** When true, this is a Refine session over an already-bound chat:
   *  on coach-done the dispatcher dispatches to graduateRefineSession
   *  instead of graduateAgent — no new agent / binding is created;
   *  the existing agent's system prompt is rewritten in place. */
  refining?: boolean
}

export const coachSessions = new Map<number, CoachSession>()

/** Summarize agents for the picker screen. */
export async function listExistingForPicker(sourceChatId: number): Promise<Array<{ id: string; name: string; model: string; archetype: string; icon: string; glyph: string; pattern: PatternId; tier: string; isTrusted: boolean; iconDataUri: string; bindingCount: number; isCurrentAgent: boolean; isUndeletable: boolean }>> {
  const { renderAgentBadge } = await import('../agent-icon-render.js')
  const sourceBinding = bindings.getBinding(sourceChatId)
  const { readFileSync } = await import('node:fs')
  return Promise.all(agents.listAgents().map(async a => {
    const archetype = agents.getArchetype(a) as 'role' | 'utility' | 'project'
    const tier = models.tierForModel(a.model)
    const trust = agents.getSkipPermissions(a)
    const glyph = agents.glyphForAgent(a)
    const pattern = agents.patternForAgent(a)
    let iconDataUri = ''
    try {
      const pngPath = await renderAgentBadge({ archetype, modelFamily: tier, trust, glyph, pattern })
      iconDataUri = `data:image/png;base64,${readFileSync(pngPath).toString('base64')}`
    } catch {
      /* fall back to empty — client renders a placeholder */
    }
    return {
      id: a.name,
      name: agentDisplayName(a),
      model: a.model,
      archetype,
      icon: agents.iconForAgent(a),
      pattern,
      glyph,
      tier,
      isTrusted: trust,
      iconDataUri,
      bindingCount: bindings.countByAgentId(a.name),
      isCurrentAgent: sourceBinding?.agentId === a.name,
      isUndeletable: agents.isUndeletableAgent(a.name),
    }
  }))
}

/** Minimal context for decorating agent chats (icon + welcome). */
export interface DecorateContext {
  client: Pick<import('../dc-client.js').DCClient, 'setChatProfileImage' | 'send'>
  logf: (format: string, ...args: unknown[]) => void
}

/**
 * Render the agent's badge PNG and install it as the chat profile image.
 * Inputs are derived from the agent's archetype, model family, trust
 * flag (skip-permissions), and resolved glyph (explicit override if in
 * the archetype's palette, otherwise the archetype default).
 */
export async function setAgentIcon(
  ctx: DecorateContext,
  chatId: number,
  agent: agents.AgentDef,
): Promise<void> {
  const { renderAgentBadge } = await import('../agent-icon-render.js')
  const archetype = agents.getArchetype(agent)
  const modelFamily = models.tierForModel(agent.model)
  const trust = agents.getSkipPermissions(agent)
  const glyph = agents.glyphForAgent(agent)
  const pattern = agents.patternForAgent(agent)
  const iconPath = await renderAgentBadge({ archetype, modelFamily, trust, glyph, pattern })
  await ctx.client.setChatProfileImage(chatId, iconPath)
  ctx.logf(
    'agent-setup: set agent badge %s/%s/%s/%s/%s for chat %d',
    archetype, modelFamily, trust ? 'trust' : 'plain', glyph, pattern, chatId,
  )
}

/**
 * #139: the intro must match what actually happened — "your new agent" on
 * a rebind/reuse reads like a duplicate agent was created.
 *  - created:        a genuinely new agent definition (default, back-compat)
 *  - reused:         a NEW chat for an EXISTING agent
 *  - switched:       this chat rebound to another existing agent (fresh session)
 *  - switched-kept:  same, but the conversation was carried over
 *  - none:           badge only (e.g. teleport import posts its own recap)
 */
export type DecorateIntro = 'created' | 'reused' | 'switched' | 'switched-kept' | 'none'

function introLine(agent: agents.AgentDef, intro: DecorateIntro): string | null {
  const name = agentDisplayName(agent)
  switch (intro) {
    case 'created':
      return `Hi! This is your new "${name}" agent. Send a message here to get started.`
    case 'reused':
      return `New chat with your existing "${name}" agent. Send a message here to get started.`
    case 'switched':
      return `This chat now runs your "${name}" agent — starting a fresh conversation.`
    case 'switched-kept':
      return `This chat now runs your "${name}" agent — continuing this conversation.`
    case 'none':
      return null
  }
}

/** Apply icon + context-appropriate intro after a chat has been bound to an agent. */
export async function decorateAgentChat(
  ctx: DecorateContext,
  chatId: number,
  agent: agents.AgentDef,
  intro: DecorateIntro = 'created',
): Promise<void> {
  try {
    await setAgentIcon(ctx, chatId, agent)
  } catch (err) {
    ctx.logf('agent-setup: set icon failed: %v', err)
  }

  const line = introLine(agent, intro)
  if (line === null) return
  try {
    await ctx.client.send(chatId, line)
  } catch (err) {
    ctx.logf('agent-setup: intro message send failed: %v', err)
  }
}

/**
 * Resolve which agent to attach when importing a terminal session into DC.
 * Priority: session-agents index (original agent from when DC last bound
 * this session) → source chat's current agent → default agent.
 */
export function resolveAttachAgent(sessionId: string, sourceChatId: number): string {
  // #134: validate every candidate against the live agents dir — the
  // session-agents index deliberately survives binding deletion, so it can
  // point at an agent whose .md was since deleted. Binding a new chat to a
  // ghost agent bricks it (the v1.4.16 null-agent lesson).
  const alive = (id: string | null | undefined): id is string =>
    !!id && agents.getAgent(id) !== null
  const indexed = sessionAgents.getAgentForSession(sessionId)
  if (alive(indexed)) return indexed
  const sourceAgentId = bindings.getBinding(sourceChatId)?.agentId
  if (alive(sourceAgentId)) return sourceAgentId
  return agents.DEFAULT_AGENT_ID
}

/**
 * Phase-12 reuse flow — provision a new DC chat bound to an existing
 * agent. Mirrors the legacy `bind` payload's chat-create + addContact +
 * addChat + bindAgent + decorate sequence; pulled out as a named helper
 * so it's testable with a stub AppContext (the existing handler is
 * deeply nested in the WebXDC update dispatch loop).
 *
 * Returns the new chat id on success; throws on any of the chat-create /
 * addContact / bindAgent steps. Caller is responsible for emitting the
 * chat-ready / chat-failed update back to the source setup card.
 */
export async function createReuseChat(
  ctx: AppContext,
  agent: agents.AgentDef,
  ownerContactId: number,
): Promise<number> {
  const newChatId = await ctx.client.createGroup(agentDisplayName(agent))
  await ctx.client.addContactToChat(newChatId, ownerContactId)
  access.addChat(newChatId, ownerContactId)
  bindings.bindAgent(newChatId, agent.name, {
    inheritClaudeMd: agents.inheritClaudeMdForModel(agent.model),
  })
  await decorateAgentChat(ctx, newChatId, agent, 'reused')
  return newChatId
}

/**
 * Rebind an EXISTING chat to a different agent (issue #86). Unlike
 * createReuseChat this does NOT create a new DC chat — it retargets the
 * source chat in place. Starts a fresh CC session (clearSessionId) so the
 * new agent doesn't inherit the old agent's transcript, evicts the
 * in-flight subagent so the next message spawns with the new .md, and
 * re-decorates the chat with the new agent's badge/intro.
 *
 * Throws if the chat is already bound to `agent` (caller surfaces it as a
 * chat-failed). Exported for unit testing with a stub AppContext.
 */
export async function rebindChat(
  ctx: AppContext,
  sourceChatId: number,
  agent: agents.AgentDef,
  opts: { keepContext?: boolean } = {},
): Promise<void> {
  const current = bindings.getBinding(sourceChatId)
  if (current?.agentId === agent.name) {
    throw new Error('This chat is already on that agent.')
  }
  // Default: fresh CC session for the new agent — a full identity swap
  // (different system prompt/tools/persona) shouldn't carry the old
  // agent's transcript into the new one. keepContext opts out for a
  // "wrong pick, quick handoff" rebind where the owner wants the new
  // agent to resume the same conversation instead.
  if (!opts.keepContext) {
    bindings.clearSessionId(sourceChatId)
  }
  bindings.bindAgent(sourceChatId, agent.name, {
    inheritClaudeMd: agents.inheritClaudeMdForModel(agent.model),
  })
  await ctx.evictSubagent(sourceChatId)   // next message picks up the new .md (even when keeping context)
  // Decoration is cosmetic (avatar swap + intro line). The rebind already
  // took effect above, so don't fail it — and mislead the user into a retry
  // that hits the same-agent guard — over a badge/send hiccup.
  try {
    await decorateAgentChat(ctx, sourceChatId, agent, opts.keepContext ? 'switched-kept' : 'switched')
  } catch (err) {
    ctx.logf('agent-setup: rebind decorate failed chat=%d: %v', sourceChatId, err)
  }
}

/**
 * Reply to a Phase-12 mode-picker flow on the source setup card with the
 * new chat's id and a refreshed picker list. The card listens for
 * chat-ready in setUpdateListener, closes the confirmation modal, shows a
 * mode-aware success modal (Agent switched / Chat created), and lands on
 * the manage list behind it.
 */
async function sendChatReady(
  msgId: number,
  ctx: AppContext,
  newChatId: number,
  sourceChatId: number,
): Promise<void> {
  const update = JSON.stringify({
    payload: {
      type: 'chat-ready',
      chatId: newChatId,
      // Refreshed picker data keyed on the CARD's chat (sourceChatId): a
      // rebind flips isCurrentAgent; a reuse/default bumps a bindingCount.
      // Keeps a re-opened picker from marking the OLD agent "Current".
      existingAgents: await listExistingForPicker(sourceChatId),
      senderAddr: 'server',
    },
    summary: 'Chat created',
  })
  try {
    await ctx.client.sendWebXDCUpdate(msgId, update)
  } catch (err) {
    ctx.logf('agent-setup: chat-ready dispatch failed: %v', err)
  }
}

/**
 * Reply with a chat-failed update so the card flips its modal into the
 * error state. Caller passes a user-readable error string — preserved
 * verbatim in the modal sub-line, so keep it short and non-technical
 * where possible.
 */
async function sendChatFailed(
  msgId: number,
  ctx: AppContext,
  error: string,
): Promise<void> {
  const update = JSON.stringify({
    payload: { type: 'chat-failed', error, senderAddr: 'server' },
    summary: 'Chat creation failed',
  })
  try {
    await ctx.client.sendWebXDCUpdate(msgId, update)
  } catch (err) {
    ctx.logf('agent-setup: chat-failed dispatch failed: %v', err)
  }
}

/**
 * Compose the Identity preamble for an agent's system prompt from the
 * leaves the user picked plus the coach's collected answers. Single-leaf
 * agents get a one-sentence "You are a <leaf>" line (with parameter when
 * present); mash-ups list every leaf and call out the lead lens.
 *
 * Exported for unit testing — composition is a pure transform.
 */
export function composeIdentityPreamble(
  leafIds: string[],
  answers: CoachAnswers,
  catalog: Catalog,
): string {
  const leaves = leafIds
    .map(id => catalog.findLeaf(id))
    .filter((l): l is Leaf => l !== null)
  if (leaves.length === 0) return 'You are a helpful assistant.'
  if (leaves.length === 1) {
    const l = leaves[0]
    const param = answers.parameters[l.id]
    if (l.parameter && param) {
      return `You are a ${l.name.toLowerCase()} (${param}).`
    }
    return `You are a ${l.name.toLowerCase()}.`
  }
  const lead = answers.leadLeafId ? catalog.findLeaf(answers.leadLeafId) : null
  const names = leaves.map(l => l.name).join(', ')
  if (lead) {
    return `You are a unified agent combining ${names}. ${lead.name} is the lead lens — when topics intersect, frame through ${lead.name}.`
  }
  return `You are a unified agent combining ${names}. Treat all specialties as equal partners.`
}

/**
 * Compose the human-readable agent name from leaves + answers. Single-leaf
 * agents use the leaf name directly (with parameter suffix when present);
 * mash-ups use "Lead leaf + N more". Exported for unit testing.
 */
export function composeAgentName(
  leafIds: string[],
  answers: CoachAnswers,
  catalog: Catalog,
): string {
  const leaves = leafIds
    .map(id => catalog.findLeaf(id))
    .filter((l): l is Leaf => l !== null)
  if (leaves.length === 0) return 'New agent'
  if (leaves.length === 1) {
    const param = answers.parameters[leaves[0].id]
    return param ? `${leaves[0].name} (${param})` : leaves[0].name
  }
  const lead = answers.leadLeafId ? catalog.findLeaf(answers.leadLeafId) : leaves[0]
  return `${lead.name} + ${leaves.length - 1} more`
}

/**
 * Create a new DC chat that will host a coach interview, add the owner,
 * and seed the access list. Returns the new chat id. The provisional title
 * is "New agent" — `graduateAgent` renames it once the agent is named.
 */
async function createNewAgentChat(ctx: AppContext, sourceChatId: number, ownerContactId: number): Promise<number> {
  const newChatId = await ctx.client.createGroup('New agent')
  await ctx.client.addContactToChat(newChatId, ownerContactId)
  access.addChat(newChatId, ownerContactId)
  ctx.logf('agent-setup: created new-agent chat %d for owner %d (source %d)', newChatId, ownerContactId, sourceChatId)
  return newChatId
}

/**
 * Handle the `build-agent` payload from the WebXDC wall. Creates a new
 * DC chat, kicks off a coach interview in `coachSessions`, and posts the
 * first question. If the coach has nothing to ask (degenerate leaf
 * shape), graduates immediately.
 *
 * Returns the new chat id on success so the WebXDC payload handler can
 * relay a chat-ready update back to the source setup card. Throws on
 * upstream failures (no valid leaves, missing owner, group-create
 * failure, startCoach failure) — caller turns those into chat-failed
 * updates with a user-readable message.
 *
 * Exported for the agent-creation E2E test (`agent-creation-e2e.test.ts`),
 * which drives the full build flow end to end without going through the
 * WebXDC `onWebXDCUpdate` plumbing — that path simply unwraps a
 * `build-agent` payload and calls this function with the same arguments.
 * Production callers still go through `onWebXDCUpdate`.
 */
export async function handleBuildAgent(
  ctx: AppContext,
  sourceChatId: number,
  leafIds: string[],
  pattern: PatternId,
  resolveOwner: () => Promise<number | null>,
): Promise<number> {
  // Validate against the catalog up front so we don't create a dead chat.
  const catalog = getDefaultCatalog()
  const validIds = leafIds.filter(id => catalog.findLeaf(id) !== null)
  if (validIds.length === 0) {
    throw new Error('No valid specialties were picked.')
  }

  const ownerContactId = await resolveOwner()
  if (!ownerContactId) {
    throw new Error("I can't tell who owns this chat — try unpairing and re-pairing.")
  }

  const newChatId = await createNewAgentChat(ctx, sourceChatId, ownerContactId)
  const sessionId = randomUUID()

  let coachState: CoachState
  try {
    coachState = startCoach({
      leafIds: validIds,
      preset: 'mentor',
      sliders: {},
      catalog,
    })
  } catch (err) {
    ctx.logf('agent-setup: startCoach failed for chat %d: %v', newChatId, err)
    throw new Error('Could not start the coach interview.')
  }

  coachSessions.set(newChatId, { coachState, leafIds: validIds, sessionId, pattern })

  if (coachState.nextQuestion) {
    const skipHint = '\n\n_(Or just say "let\'s go" and I\'ll use defaults.)_'
    try {
      await ctx.client.send(newChatId, coachState.nextQuestion + skipHint)
    } catch (err) {
      ctx.logf('agent-setup: build-agent first-question send failed: %v', err)
    }
  } else {
    // No questions for this leaf shape — graduate immediately.
    await graduateAgent(ctx, newChatId)
  }
  return newChatId
}

/**
 * Finalize a coach interview: compose Identity preamble, assemble the
 * full system prompt, write the AgentDef + Binding, refresh the chat
 * badge, log the lifecycle event, clear the coach session, and bootstrap
 * the new agent's first turn via subagent dispatch.
 *
 * Exported for the dispatcher's coach-interception path.
 */
export async function graduateAgent(ctx: AppContext, chatId: number): Promise<void> {
  const session = coachSessions.get(chatId)
  if (!session) return
  // Build-new sessions always have sessionId (set by handleBuildAgent).
  // Refine sessions don't and shouldn't reach this function — the
  // dispatcher branches to graduateRefineSession on session.refining.
  if (!session.sessionId) {
    ctx.logf('agent-setup: graduateAgent reached with no sessionId chat=%d (refine session leaked into build-new path?)', chatId)
    coachSessions.delete(chatId)
    return
  }
  const sessionId = session.sessionId

  // Wrap the entire post-validation graduation body in a single try/catch.
  // Previous structure had narrow try/catches around assembleSystemPrompt
  // and saveAgent only — a throw from saveBinding/setChatName/setAgentIcon
  // would orphan the chat in a half-state (agent YAML on disk, no binding,
  // coach session not always cleared) and the user would see nothing. The
  // catch below: logs, posts a user-visible message, clears in-memory
  // state, and emits a lifecycle event so a downstream tool can surface
  // partial graduations. coachLocks cleanup happens at the call site
  // (server.ts) once this function returns.
  try {
    const catalog = getDefaultCatalog()
    const answers = collectAnswers(session.coachState)

    const identityPreamble = composeIdentityPreamble(session.leafIds, answers, catalog)
    const agentName = composeAgentName(session.leafIds, answers, catalog)

    const systemPrompt = assembleSystemPrompt({
      leafIds: session.leafIds,
      // assembleSystemPrompt rejects leadLeafId on single-leaf agents.
      leadLeafId: session.leafIds.length > 1 ? answers.leadLeafId : undefined,
      preset: 'mentor',
      sliders: {},
      preferences: answers.preferences,
      tools: answers.tools,
      identityPreamble,
      catalog,
    })

    // Synthesize the agent id BEFORE saveAgent so we have one stable
    // identifier for the whole graduation. (Pre-fix this happened in the
    // same place but the structure didn't make the sequencing intent
    // explicit. Keeping it here so a downstream change can't accidentally
    // hoist saveAgent earlier and re-introduce the partial-graduation
    // namespace fork via a retry.)
    const agentId = agents.synthesizeAgentName(agentName)
    // Coach metadata (x-dc-leaves, x-dc-personality-*, x-dc-coach-answers)
    // lives under .passthrough() — not validated by the schema, but preserved
    // on round-trip. Cast to unknown to keep the type system out of it.
    const newAgent = {
      name: agentId,
      'x-dc-display-name': agentName,
      model: agents.DEFAULT_MODEL,
      description: '',
      body: systemPrompt,
      // Wall+coach has no per-tool picker — default to the full built-in
      // toolkit so users get a usable agent out of the box. mcp__dc is
      // injected by saveAgent's ensureMcpDc. Pre-fix this was the literal
      // string 'mcp__dc' (regressed in commit 1d904b1, 2026-05-17), leaving
      // wall+coach agents toolless except for the dc proxy.
      tools: ALL_BUILTIN_TOOLS.join(', '),
      memory: 'user' as const,
      'x-dc-leaves': session.leafIds,
      'x-dc-personality-preset': 'mentor',
      'x-dc-personality-sliders': {},
      'x-dc-coach-answers': answers as unknown as Record<string, unknown>,
      // graduateAgent is only invoked for build-new (non-refine)
      // sessions, where session.pattern is set by the review screen.
      // Fall back to 'checker' for safety.
      'x-dc-pattern': session.pattern ?? 'checker',
      // Legacy compat — drives existing badge palette / archetype-aware logic.
      'x-dc-archetype': 'role' as const,
      // Wall+coach has no memory-boost toggle in its flow, so there's no card
      // payload here — classify straight from the synthesized system prompt.
      'x-dc-memory-boost': agents.classifyMemoryBoost(systemPrompt),
    } as unknown as agents.AgentDef
    // Roll a random orientation so same-model agents are visually
    // differentiable (mirrors the templated/create paths).
    agents.setIconMirror(newAgent, Math.random() < 0.5)

    agents.saveAgent(newAgent)

    // First-time binding for this chat — coach lived only in `coachSessions`
    // until now. Persist the same sessionId so claude --resume can be used
    // by the subagent on first spawn.
    bindings.saveBinding({
      chatId,
      agentId,
      sessionId,
      inheritClaudeMd: agents.inheritClaudeMdForModel(newAgent.model),
      workingDir: process.cwd(),
      createdAt: new Date().toISOString(),
    })

    // Seed the owner's contact record in the new agent's sidecar.
    // Without this, isContactPermissioned(agentId, contactId) finds no file
    // and rejects every first message with "unauthorized sender" (#115).
    const ownerContactId = access.firstPermissionedContact(chatId)
    if (ownerContactId) access.recordContactPair(agentId, ownerContactId)

    // Rename the chat to the agent name + install the agent badge so the
    // chat avatar swaps from the placeholder to the real agent. These two
    // are still individually try/caught because they're cosmetic — a
    // failure here shouldn't roll back a successful agent+binding write.
    try {
      await ctx.client.setChatName(chatId, agentName)
    } catch (err) {
      ctx.logf('agent-setup: graduation rename failed chat=%d: %v', chatId, err)
    }
    try {
      await setAgentIcon(ctx, chatId, newAgent)
    } catch (err) {
      ctx.logf('agent-setup: graduation icon refresh failed chat=%d: %v', chatId, err)
    }

    coachSessions.delete(chatId)

    logLifecycleEvent({
      kind: 'graduation',
      chatId,
      agentId,
      sessionId,
      leafIds: session.leafIds,
      fromCoach: true,
    })

    // Post the agent's first message into the new chat. We send a plain
    // greeting here rather than driving the agent's first turn through the
    // subagent — the subagent will spawn lazily on the user's next message
    // and respond in-character via the just-written system prompt. The
    // coach Q&A isn't in the agent's session history; it's already baked
    // into the prompt via assembleSystemPrompt + composeIdentityPreamble,
    // and the raw answers are preserved in metadata['x-dc-coach-answers'].
    try {
      await ctx.client.send(chatId, `Ready! I'm your "${agentName}" agent. Anything you say from here on lands with me.`)
    } catch (err) {
      ctx.logf('agent-setup: graduation greeting failed chat=%d: %v', chatId, err)
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    ctx.logf('agent-setup: graduation failed for chat %d: %v', chatId, err)
    // Always clear in-memory state so the chat doesn't loop on the same
    // failure if the user sends another message.
    coachSessions.delete(chatId)
    // Emit a lifecycle event so the partial-graduation case is observable
    // alongside successful graduations.
    logLifecycleEvent({
      kind: 'graduation-failed',
      chatId,
      sessionId,
      leafIds: session.leafIds,
      reason,
    })
    // Tell the user something went wrong — silent failure is worse than
    // a generic message because the chat is now in an unusable in-between
    // state and the user has no idea why.
    try {
      await ctx.client.send(
        chatId,
        "Sorry — I couldn't finish setting up your agent. Say \"set up an agent\" to start over, or \"help me set up an agent\" to browse the catalog again.",
      )
    } catch (sendErr) {
      ctx.logf('agent-setup: graduation-failure notice send failed chat=%d: %v', chatId, sendErr)
    }
  }
}

/**
 * Finalize a Refine coach session: load the bound agent, splice the
 * coach's new preferences into its system prompt, write back. Unlike
 * graduateAgent, this path does NOT create a new agent or binding —
 * the chat stays attached to the same agent (and same session UUID),
 * and there's no badge/icon swap. Caller (server.ts coach-interception)
 * is responsible for clearing coachSessions before this returns.
 */
export async function graduateRefineSession(ctx: AppContext, chatId: number): Promise<void> {
  const session = coachSessions.get(chatId)
  if (!session) return
  const refineCtx = session.coachState.refineContext
  if (!refineCtx) {
    ctx.logf('agent-setup: graduateRefineSession called without refineContext chat=%d', chatId)
    coachSessions.delete(chatId)
    return
  }
  try {
    const { refineSystemPrompt } = await import('../prompt-assembler.js')
    const agent = agents.getAgent(refineCtx.agentId)
    if (!agent) {
      throw new Error(`agent ${refineCtx.agentId} disappeared during refine`)
    }
    const answers = collectAnswers(session.coachState)
    const newSystem = refineSystemPrompt(agent.body, answers)
    if (newSystem !== agent.body) {
      agents.saveAgent({ ...agent, body: newSystem })
      // Evict the cached subagent so the next message cold-spawns under
      // the new system prompt. Without this the user gets the "Done"
      // reply but keeps talking to a process whose prompt was baked in
      // at spawn — change wouldn't take effect until idle timeout / LRU
      // eviction (up to 15 minutes). Best-effort: a failed evict
      // shouldn't suppress the confirmation reply.
      await ctx.evictSubagent(chatId).catch((err) =>
        ctx.logf('agent-setup: refine evict failed chat=%d: %v', chatId, err),
      )
      const refineSessionId = bindings.getBinding(chatId)?.sessionId ?? ''
      logLifecycleEvent({
        kind: 'refine-complete',
        chatId,
        agentId: refineCtx.agentId,
        sessionId: refineSessionId,
      })
    }
    coachSessions.delete(chatId)
    try {
      await ctx.client.send(chatId, 'Done — incorporated.')
    } catch (err) {
      ctx.logf('agent-setup: refine confirmation send failed chat=%d: %v', chatId, err)
    }
  } catch (err) {
    ctx.logf('agent-setup: refine graduation failed chat=%d: %v', chatId, err)
    coachSessions.delete(chatId)
    try {
      await ctx.client.send(
        chatId,
        "Sorry — I couldn't apply that refinement. The agent is unchanged.",
      )
    } catch (sendErr) {
      ctx.logf('agent-setup: refine-failure notice send failed chat=%d: %v', chatId, sendErr)
    }
  }
}

/**
 * Resolve the owner contact for a new chat created from a setup/create
 * card opened in `sourceChatId`. Prefers the first permissioned contact
 * (the common 1:1 case); falls back to the first non-self member of the
 * source chat. Returns null when no human can be identified.
 *
 * Shared by the monolith's create/build-agent branches and the standalone
 * create-app card so the owner-resolution policy lives in one place.
 */
export async function resolveOwnerForChat(
  ctx: AppContext,
  sourceChatId: number,
): Promise<number | null> {
  const ownerContactId = access.firstPermissionedContact(sourceChatId)
  if (ownerContactId) return ownerContactId
  try {
    const contacts = await ctx.client.getChatContacts(sourceChatId)
    const found = contacts.find(id => id !== 1)
    if (!found) {
      ctx.logf('agent-setup: could not find contact in source chat %d', sourceChatId)
      return null
    }
    return found
  } catch (err) {
    ctx.logf('agent-setup: getChatContacts failed for chat %d: %v', sourceChatId, err)
    return null
  }
}

/**
 * Form-`create` handler: persist an agent definition from the create
 * form's config payload, and (unless `skipChat`) spin up a new bound DC
 * chat for it. Extracted from the monolith's `create` dispatch branch so
 * both the monolith and the standalone create-app card call one function.
 *
 * Gated by `auth` (same pattern as `handleAssignRole`): on a failed auth
 * result it emits a `create_err` reply and returns without mutating state.
 *
 * On success it replies `{type:'created', chatId, name, skipChat,
 * senderAddr:'server'}` so the card can clear its in-flight state and show
 * the success modal. For `skipChat` (library-only create from Manage) it
 * additionally re-fires the monolith's init so the Manage screen's agent
 * list refreshes — that branch is monolith-only (the standalone create
 * card has no Manage screen).
 *
 * @param ctx  AppContext (or a compatible stub for tests).
 * @param msgId  The card's msgId — used to send WebXDC updates back.
 * @param sourceChatId  The chat the card was opened from (owner resolution).
 * @param payload  Decoded `create` payload from the card.
 * @param auth  Auth callback; returns {ok:true} or {ok:false, reason}.
 */
export async function handleCreateAgent(
  ctx: AppContext,
  msgId: number,
  sourceChatId: number,
  payload: { type?: string; config?: unknown; [key: string]: unknown },
  auth: () => Promise<{ ok: true } | { ok: false; reason: 'no-owner' | 'needs-confirmation' }>,
): Promise<void> {
  const parsed = agents.DraftAgentSchema.safeParse(payload.config)
  if (!parsed.success) {
    ctx.logf('agent-setup: invalid config from chat %d: %v', sourceChatId, parsed.error)
    return
  }

  // §6 authorization gate — fail-safe refuse, mirroring handleAssignRole.
  const authResult = await auth()
  if (!authResult.ok) {
    const message = authResult.reason === 'needs-confirmation'
      ? "Creating an agent in a group has to come from you directly — send it as a message here (e.g. \"create an agent that ...\"), or open this card from your 1:1 chat with me."
      : 'No owner found for this chat.'
    await ctx.client.sendWebXDCUpdate(msgId, JSON.stringify({
      payload: { type: 'create_err', message, senderAddr: 'server' },
      summary: 'Create unauthorized',
    })).catch(() => {})
    return
  }

  const draft = parsed.data
  const skipPerms = (payload as { skipPermissions?: boolean }).skipPermissions === true
  // #97: "+ Create new agent" from the Manage screen sets skipChat:true
  // — we save the agent into the library only and skip the chat-creation
  // steps (createGroup / addContactToChat / bindAgent / decorateAgentChat).
  // Mirrors terminal CC's `/agents` flow: an agent definition is a pure
  // library artifact, not tied to a chat. The legacy form-based create
  // path (no skipChat) still creates a chat as before.
  const skipChat = (payload as { skipChat?: boolean }).skipChat === true
  const rawArchetype = (payload as { archetype?: unknown }).archetype
  const archetype = (typeof rawArchetype === 'string' && (agents.ARCHETYPES as readonly string[]).includes(rawArchetype))
    ? rawArchetype as agents.Archetype : null
  const allowedBuiltinTools = (payload as { allowedBuiltinTools?: string[] | null }).allowedBuiltinTools ?? undefined
  const allowedMcpServers = (payload as { allowedMcpServers?: string[] | null }).allowedMcpServers ?? undefined
  const inheritClaudeMd = agents.inheritClaudeMdForModel(draft.model)

  // Resolve the owner contact for the new chat (1:1 source: extract from
  // contacts; group source: use the first permissioned contact).
  const ownerContactId = await resolveOwnerForChat(ctx, sourceChatId)
  if (!ownerContactId) return

  // Display name comes from the form's `name` payload field, slugged
  // for the canonical `name`. The display label is preserved in
  // x-dc-display-name.
  const displayName = (draft as unknown as { name?: string }).name
    ?? agents.DEFAULT_AGENT_ID
  const agentId = agents.synthesizeAgentName(displayName)
  try {
    // Chat creation only on the legacy path; skipChat short-circuits.
    let newChatId: number | null = null
    if (!skipChat) {
      newChatId = await ctx.client.createGroup(displayName)
      await ctx.client.addContactToChat(newChatId, ownerContactId)
      access.addChat(newChatId, ownerContactId)
    }
    const newAgent: agents.AgentDef = {
      ...draft,
      name: agentId,
      'x-dc-display-name': displayName,
      // buildCreateAgentToolsCsv encodes the client picker's null=all,
      // [] =none semantics so a user who taps Create with the default
      // (all-checked) picker gets the full built-in toolkit, not an
      // empty CSV. Pre-fix, `?? []` made null → none → no built-ins.
      tools: buildCreateAgentToolsCsv(allowedBuiltinTools, allowedMcpServers),
      'x-dc-memory-boost': resolveMemoryBoost((payload as { memoryBoost?: boolean }).memoryBoost, draft.body ?? ''),
    } as agents.AgentDef
    agents.setSkipPermissions(newAgent, skipPerms)
    if (archetype) agents.setArchetype(newAgent, archetype)
    const rawIcon = (payload as { icon?: unknown }).icon
    if (typeof rawIcon === 'string' && rawIcon.trim()) {
      agents.setIcon(newAgent, rawIcon.trim())
    }
    // Roll a random orientation once at creation so same-model agents
    // are visually differentiable. Edits can override via the setup card.
    agents.setIconMirror(newAgent, Math.random() < 0.5)
    agents.saveAgent(newAgent)
    if (!skipChat && newChatId !== null) {
      bindings.bindAgent(newChatId, agentId, { inheritClaudeMd })
      // Seed the owner's contact record so the first message isn't
      // rejected as "unauthorized sender" (#115).
      access.recordContactPair(agentId, ownerContactId)
      const savedAgent = agents.getAgent(agentId)
      if (savedAgent) await decorateAgentChat(ctx, newChatId, savedAgent, 'created')
      ctx.logf('agent-setup: created agent %s for chat %d (owner %d)', agentId, newChatId, ownerContactId)
    } else {
      ctx.logf('agent-setup: created agent %s (library only, no chat) (owner %d)', agentId, ownerContactId)
    }

    const update = JSON.stringify({
      payload: { type: 'created', chatId: newChatId, name: draft.name, skipChat, senderAddr: 'server' },
      summary: 'Agent created',
    })
    await ctx.client.sendWebXDCUpdate(msgId, update)
    // Session stays alive — the caller card may keep operating. The
    // former skipChat re-init (monolith Manage-screen refresh) is gone
    // with the monolith; the standalone create card never sets skipChat.
  } catch (err) {
    ctx.logf('agent-setup: create failed: %v', err)
    // Roll back the agent file if it was written but binding failed.
    try { agents.deleteAgent(agentId) } catch {}
  }
}

/**
 * Auth callback shape shared by every §6-gated manage handler. Returns
 * `{ok:true}` when the caller is authorized to mutate state from this card,
 * or `{ok:false, reason}` when the tap can't be authenticated (multi-human
 * group → `needs-confirmation`; no resolvable owner → `no-owner`).
 */
type ControlAuth = () => Promise<{ ok: true } | { ok: false; reason: 'no-owner' | 'needs-confirmation' }>

/**
 * §6 refusal reply for a state-changing manage handler. Emits ONE generic
 * `action_err` type (decision #1, increment 4) so the standalone
 * agent-manage card needs a single refusal handler regardless of which
 * action was refused. Returns true when the caller should stop (refused).
 */
export async function refuseIfUnauthorized(
  ctx: AppContext,
  msgId: number,
  auth: ControlAuth,
): Promise<boolean> {
  const authResult = await auth()
  if (authResult.ok) return false
  const message = authResult.reason === 'needs-confirmation'
    ? 'That change has to come from you directly — send it as a message here (e.g. "switch this chat to <agent name>"), or open this card from your 1:1 chat with me.'
    : 'No owner found for this chat.'
  await ctx.client.sendWebXDCUpdate(msgId, JSON.stringify({
    payload: { type: 'action_err', message, senderAddr: 'server' },
    summary: 'Action unauthorized',
  })).catch(() => {})
  return true
}

/**
 * Read-only: re-open the setup card with an existing agent pre-filled for
 * editing. Surfaces the edit draft only (no mutation), so it carries no §6
 * auth gate. Extracted from the monolith's `editRequest` dispatch branch.
 */
export async function handleEditRequest(
  ctx: AppContext,
  msgId: number,
  _sourceChatId: number,  // unused; kept positional for symmetry with sibling handlers (#117)
  agentId: string,
): Promise<void> {
  // Edit an existing agent. Re-open the setup card with the agent pre-filled.
  if (!agentId) {
    ctx.logf('agent-setup: edit payload missing agentId')
    return
  }
  const agent = agents.getAgent(agentId)
  if (!agent) {
    ctx.logf('agent-setup: edit requested agent %s not found', agentId)
    return
  }
  const editDraft = legacyDraftFromAgent(agent)
  try {
    const update = JSON.stringify({
      payload: {
        type: 'edit',
        draft: editDraft,
        version: getAgentManageVersion(),
        senderAddr: 'server',
        availableModels: models.MODELS.map(m => ({ id: m.id, label: m.label, tier: m.tier })),
        defaultModel: models.DEFAULT_MODEL,
        ...availableToolsPayload(ctx),
      },
      summary: 'Editing agent',
    })
    await ctx.client.sendWebXDCUpdate(msgId, update)
    ctx.logf('agent-setup: sent edit screen for agent %s', agentId)
  } catch (err) {
    ctx.logf('agent-setup: edit send failed: %v', err)
  }
}

/**
 * §6-gated: delete an agent, rebind any affected chats to the default
 * assistant, and reply `{type:'deleted', existingAgents}`. On a refused
 * auth result it emits `action_err` and mutates nothing. Extracted from the
 * monolith's `delete` dispatch branch.
 */
export async function handleDeleteAgent(
  ctx: AppContext,
  msgId: number,
  sourceChatId: number,
  agentId: string,
  auth: ControlAuth,
): Promise<void> {
  if (await refuseIfUnauthorized(ctx, msgId, auth)) return
  if (!agentId) {
    ctx.logf('agent-setup: delete payload missing agentId')
    return
  }
  if (agents.isUndeletableAgent(agentId)) {
    // #135: emit a real error — the silent return left the card hanging in
    // pendingAction:'delete' until a misattributed 10s "No response" modal.
    ctx.logf('agent-setup: refusing to delete built-in default agent %s', agentId)
    await ctx.client.sendWebXDCUpdate(msgId, JSON.stringify({
      payload: { type: 'action_err', message: 'The built-in default agent can’t be deleted.', senderAddr: 'server' },
      summary: 'Delete refused',
    })).catch(() => {})
    return
  }
  const agent = agents.getAgent(agentId)
  if (!agent) {
    ctx.logf('agent-setup: delete requested agent %s not found', agentId)
    await ctx.client.sendWebXDCUpdate(msgId, JSON.stringify({
      payload: { type: 'action_err', message: `Agent "${agentId}" no longer exists.`, senderAddr: 'server' },
      summary: 'Delete refused',
    })).catch(() => {})
    return
  }
  try {
    // Rebind affected chats to the default agent and refresh their
    // profile icon so the chat avatar reflects the new assistant
    // immediately (don't wait for the next message / auto-repair).
    const affected = bindings.listBindings().filter(b => b.agentId === agentId)
    if (affected.length > 0) {
      const defaultAgent = agents.ensureDefaultAgent()
      await Promise.all(
        affected.map(b =>
          ctx.client.send(
            b.chatId,
            `The "${agent.name}" agent was deleted. This chat will use the "${defaultAgent.name}" default assistant.`,
          ).catch(() => {}),
        ),
      )
      await Promise.all(
        affected.map(async b => {
          await ctx.evictSubagent(b.chatId)
          bindings.saveBinding({
            chatId: b.chatId,
            agentId: defaultAgent.name,
            inheritClaudeMd: agents.inheritClaudeMdForModel(defaultAgent.model),
            createdAt: new Date().toISOString(),
          })
          bindings.clearSessionId(b.chatId)
          try {
            await setAgentIcon({ client: ctx.client, logf: ctx.logf }, b.chatId, defaultAgent)
          } catch (err) {
            ctx.logf('agent-setup: icon refresh failed for chat %d: %v', b.chatId, err)
          }
        }),
      )
      ctx.logf('agent-setup: rebound %d chat(s) from agent %s to default', affected.length, agentId)
    }

    agents.deleteAgent(agentId)
    ctx.logf('agent-setup: deleted agent %s', agentId)
    const update = JSON.stringify({
      payload: {
        type: 'deleted',
        name: agent.name,
        existingAgents: await listExistingForPicker(sourceChatId),
        version: getAgentManageVersion(),
        senderAddr: 'server',
      },
      summary: 'Agent deleted',
    })
    await ctx.client.sendWebXDCUpdate(msgId, update)
    // Keep the session alive — user stays on the main screen
    // and may want to delete/edit more agents.
  } catch (err) {
    ctx.logf('agent-setup: delete failed: %v', err)
  }
}

/**
 * Low-stakes read-only: write the agent's YAML to a `.md`-style attachment
 * in the owner's own chat and reply `{type:'exported'}`. No §6 gate — this
 * only exposes the caller's own agent definition back to them. Extracted
 * from the monolith's `export` dispatch branch.
 */
export async function handleExportAgent(
  ctx: AppContext,
  msgId: number,
  sourceChatId: number,
  agentId: string,
): Promise<void> {
  if (!agentId) {
    ctx.logf('agent-setup: export payload missing agentId')
    return
  }
  const agent = agents.getAgent(agentId)
  if (!agent) {
    ctx.logf('agent-setup: export requested agent %s not found', agentId)
    try {
      const update = JSON.stringify({
        payload: {
          type: 'exportError',
          message: 'Agent no longer exists.',
          version: getAgentManageVersion(),
          senderAddr: 'server',
        },
        summary: 'Export failed',
      })
      await ctx.client.sendWebXDCUpdate(msgId, update)
    } catch (err) {
      ctx.logf('agent-setup: export error update failed: %v', err)
    }
    return
  }
  try {
    const { writeFileSync, unlinkSync, mkdtempSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')

    // #130: export the same frontmatter-markdown format the importer (and
    // terminal CC's ~/.claude/agents/) reads — the old YAML.stringify
    // document failed its own re-import ("missing frontmatter").
    const text = agents.exportAgentMarkdown(agent)
    const dir = mkdtempSync(join(tmpdir(), 'dc-agent-export-'))
    const filePath = join(dir, `${agentId}.md`)
    writeFileSync(filePath, text)

    await ctx.client.sendAttachment(
      sourceChatId,
      filePath,
      `Exported agent "${agent.name}"`,
    )
    ctx.logf('agent-setup: exported agent %s to chat %d', agentId, sourceChatId)

    // Notify the card so it can reset the button state.
    const update = JSON.stringify({
      payload: {
        type: 'exported',
        agentId,
        version: getAgentManageVersion(),
        senderAddr: 'server',
      },
      summary: 'Agent exported',
    })
    await ctx.client.sendWebXDCUpdate(msgId, update)

    // Clean up temp file.
    try { unlinkSync(filePath) } catch {}
  } catch (err) {
    ctx.logf('agent-setup: export failed for agent %s: %v', agentId, err)
    // Surface the failure to the card so it can flip to the error modal
    // instead of leaving the export button spinning (matches the
    // agent-not-found path above).
    try {
      await ctx.client.sendWebXDCUpdate(msgId, JSON.stringify({
        payload: {
          type: 'exportError',
          message: err instanceof Error ? err.message : 'Could not export the agent.',
          version: getAgentManageVersion(),
          senderAddr: 'server',
        },
        summary: 'Export failed',
      }))
    } catch (sendErr) {
      ctx.logf('agent-setup: export error update failed: %v', sendErr)
    }
  }
}

/**
 * §6-gated: persist an edit to an existing agent from the card's legacy
 * form payload, evict/restart affected subagents, and reply
 * `{type:'editComplete', name, existingAgents}`. On a refused auth result
 * it emits `action_err` and mutates nothing. Extracted from the monolith's
 * `saveEdit` dispatch branch.
 */
export async function handleSaveEdit(
  ctx: AppContext,
  msgId: number,
  sourceChatId: number,
  payload: { type?: string; config?: unknown; agentId?: string; [key: string]: unknown },
  auth: ControlAuth,
): Promise<void> {
  if (await refuseIfUnauthorized(ctx, msgId, auth)) return
  // Legacy WebXDC form contract — full rewrite is Slice 6. This handler
  // adapts the v1.3-shape payload onto the v1.4 AgentDef in-memory shape.
  const agentId = typeof payload.agentId === 'string' ? payload.agentId : ''
  if (!agentId) {
    ctx.logf('agent-setup: saveEdit missing agentId')
    return
  }
  const agent = agents.getAgent(agentId)
  if (!agent) {
    ctx.logf('agent-setup: saveEdit requested agent %s not found', agentId)
    return
  }
  // Translate the legacy config payload to a v1.4 AgentDef:
  //   { id, name (display), model, system, tools:[], allowedBuiltinTools, allowedMcpServers }
  //   →
  //   { name (slug), x-dc-display-name, model, body, tools: CSV }
  const config = (payload.config ?? {}) as Record<string, unknown>
  const allowedBuiltinTools = (payload as { allowedBuiltinTools?: string[] | null }).allowedBuiltinTools
    ?? (config.allowedBuiltinTools as string[] | null | undefined)
    ?? undefined
  const allowedMcpServers = (payload as { allowedMcpServers?: string[] | null }).allowedMcpServers
    ?? (config.allowedMcpServers as string[] | null | undefined)
    ?? undefined
  const draft = {
    name: typeof config.id === 'string' ? config.id : agentId,
    description: typeof config.description === 'string' ? config.description : '',
    model: typeof config.model === 'string' ? config.model : agent.model,
    tools: [
      ...(allowedBuiltinTools ?? []),
      ...((allowedMcpServers ?? []).map(s => `mcp__${s}`)),
    ].join(', '),
    body: typeof config.system === 'string' ? config.system : agent.body,
    'x-dc-display-name': typeof config.name === 'string' ? config.name : undefined,
  }
  const skipPerms = (payload as { skipPermissions?: boolean }).skipPermissions === true
  const iconMirror = (payload as { iconMirror?: boolean }).iconMirror === true
  const rawArchetype = (payload as { archetype?: unknown }).archetype
  const archetype = (typeof rawArchetype === 'string' && (agents.ARCHETYPES as readonly string[]).includes(rawArchetype))
    ? rawArchetype as agents.Archetype : null
  const prevModel = agent.model
  const prevSystem = agent.body
  const prevSkip = agents.getSkipPermissions(agent)
  const prevMirror = agents.getIconMirror(agent)
  const prevArchetype = agents.getArchetype(agent)
  const prevExplicitIcon = agents.getExplicitIcon(agent)
  try {
    // Preserve any unknown frontmatter (via .passthrough()) by spreading
    // the existing agent first, then overlaying the new fields. v1.4
    // x-dc-* extensions live at top level — saveAgent's mcp__dc inject
    // covers the tools field.
    const updated: agents.AgentDef = {
      ...agent,
      ...draft,
      name: agentId,
    } as agents.AgentDef
    agents.setSkipPermissions(updated, skipPerms)
    // Only write when the card actually sent the field, so an
    // un-upgraded older card instance that omits memoryBoost can't
    // silently clobber the stored value (the `...agent` spread
    // preserves it otherwise).
    const memoryBoostRaw = (payload as { memoryBoost?: boolean }).memoryBoost
    if (typeof memoryBoostRaw === 'boolean') {
      agents.setMemoryBoost(updated, memoryBoostRaw ? 'on' : 'off')
    }
    agents.setIconMirror(updated, iconMirror)
    if (archetype) agents.setArchetype(updated, archetype)
    const rawIcon = (payload as { icon?: unknown }).icon
    if (typeof rawIcon === 'string') {
      agents.setIcon(updated, rawIcon.trim() || null)
    }
    agents.saveAgent(updated)
    ctx.logf(
      'agent-setup: edited agent %s (model=%s skip=%s mirror=%s archetype=%s)',
      agentId, draft.model, skipPerms, iconMirror, archetype ?? 'unchanged',
    )

    // Evict all cached subagents bound to this agent so they respawn
    // with the new model/prompt on the next message. Also update
    // inheritClaudeMd on each binding in case the model changed
    // (e.g. haiku→sonnet flips inherit from false→true).
    //
    // If the model changed, clear session IDs too — Claude Code's
    // built-in system prompt ("You are powered by model X") is baked
    // into the session store at creation time and replayed on resume.
    // There's no way to override it, so a model change requires a
    // fresh session.
    const modelChanged = prevModel !== draft.model
    const systemChanged = prevSystem !== draft.body
    const skipPermsChanged = prevSkip !== skipPerms
    const mirrorChanged = prevMirror !== iconMirror
    const archetypeChanged = archetype != null && prevArchetype !== archetype
    const newExplicitIcon = agents.getExplicitIcon(updated)
    const explicitIconChanged = prevExplicitIcon !== newExplicitIcon
    // v1.4 single source: compare the tools CSV directly.
    const toolsChanged = (agent.tools ?? '') !== draft.tools
    // Restart on any change that's baked into the subagent at spawn
    // time. v1.4: --permission-mode is passed at spawn so toggling
    // skipPermissions via this card MUST evict, otherwise the running
    // subagent keeps the old mode for MCP tool calls (which don't
    // route through the PreToolUse hook, so the dispatcher can't
    // re-read the .md mid-flight). The NL meta-command "trust me"
    // path evicts via its own handler; this card is the regression
    // surface (Oliver P1-4). Cosmetic changes (icon orientation,
    // archetype, mirror) don't affect spawn argv — no restart needed.
    const needsRestart =
      modelChanged || systemChanged || toolsChanged || skipPermsChanged
    const iconChanged =
      modelChanged || skipPermsChanged || mirrorChanged ||
      archetypeChanged || explicitIconChanged
    const affected = bindings.listBindings().filter(b => b.agentId === agentId)
    const newInherit = agents.inheritClaudeMdForModel(draft.model)

    // Notify affected chats before evicting so the user knows
    // the pause is intentional, not a hang.
    if (needsRestart && affected.length > 0) {
      const restartMsg = modelChanged
        ? `Agent updated. Restarting with new model (${draft.model.replace('claude-', '')})...`
        : toolsChanged
          ? 'Agent updated. Restarting with new tool configuration...'
          : 'Agent updated. Restarting...'
      await Promise.all(
        affected.map(b => ctx.client.send(b.chatId, restartMsg).catch(() => {})),
      )
    }

    await Promise.all(
      affected.map(async b => {
        if (b.inheritClaudeMd !== newInherit) {
          bindings.saveBinding({ ...b, inheritClaudeMd: newInherit })
        }
        if (modelChanged) {
          bindings.clearSessionId(b.chatId)
        }
        if (iconChanged) {
          await setAgentIcon(ctx, b.chatId, updated).catch(err =>
            ctx.logf('agent-setup: icon update failed chat=%d: %v', b.chatId, err),
          )
        }
        if (needsRestart) {
          await ctx.evictSubagent(b.chatId)
        }
      }),
    )
    if (needsRestart && affected.length > 0) {
      ctx.logf(
        'agent-setup: evicted %d subagent(s) for agent %s%s',
        affected.length, agentId, modelChanged ? ' (model changed, sessions cleared)' : '',
      )
    }

    const update = JSON.stringify({
      payload: {
        type: 'editComplete',
        name: draft.name,
        existingAgents: await listExistingForPicker(sourceChatId),
        version: getAgentManageVersion(),
        senderAddr: 'server',
      },
      summary: 'Agent updated',
    })
    await ctx.client.sendWebXDCUpdate(msgId, update)
    // Keep the session alive — user stays on the main screen.
  } catch (err) {
    ctx.logf('agent-setup: saveEdit failed: %v', err)
  }
}

/**
 * §6-gated: reuse an existing agent definition in a NEW DC chat (legacy
 * `bind` flow — replies `{type:'created', chatId, name}`). On a refused
 * auth result it emits `action_err` and mutates nothing. Extracted from the
 * monolith's `bind` dispatch branch.
 */
export async function handleBindAgent(
  ctx: AppContext,
  msgId: number,
  sourceChatId: number,
  payload: { type?: string; agentId?: string; [key: string]: unknown },
  auth: ControlAuth,
): Promise<void> {
  if (await refuseIfUnauthorized(ctx, msgId, auth)) return
  // Reuse an existing agent definition in a new DC chat.
  const agentId = typeof payload.agentId === 'string' ? payload.agentId : ''
  if (!agentId) {
    ctx.logf('agent-setup: bind payload missing agentId')
    return
  }
  const agent = agents.getAgent(agentId)
  if (!agent) {
    ctx.logf('agent-setup: bind requested agent %s not found', agentId)
    return
  }
  const ownerContactId = await resolveOwnerForChat(ctx, sourceChatId)
  if (!ownerContactId) return

  try {
    const newChatId = await ctx.client.createGroup(agent.name)
    await ctx.client.addContactToChat(newChatId, ownerContactId)
    access.addChat(newChatId, ownerContactId)
    bindings.bindAgent(newChatId, agent.name, {
      inheritClaudeMd: agents.inheritClaudeMdForModel(agent.model),
    })
    await decorateAgentChat(ctx, newChatId, agent, 'reused')
    ctx.logf('agent-setup: bound existing agent %s to new chat %d for owner %d', agent.name, newChatId, ownerContactId)

    const update = JSON.stringify({
      payload: {
        type: 'created',
        chatId: newChatId,
        name: agent.name,
        // Refreshed picker data: the reused agent just gained a bound chat,
        // so its bindingCount is stale in the card's manage list.
        existingAgents: await listExistingForPicker(sourceChatId),
      },
      summary: 'Agent created',
    })
    await ctx.client.sendWebXDCUpdate(msgId, update)
    // Session stays alive — user may keep using the settings card.
  } catch (err) {
    ctx.logf('agent-setup: bind failed: %v', err)
  }
}

/**
 * §6-gated: default-agent quick path from the mode picker. Same chat-create
 * flow as handleStartReuseChat but the agent is the built-in default.
 * Replies `chat-ready`/`chat-failed`; on a refused auth result it emits
 * `action_err`. Extracted from the monolith's `start-default-chat` branch.
 */
export async function handleStartDefaultChat(
  ctx: AppContext,
  msgId: number,
  sourceChatId: number,
  auth: ControlAuth,
): Promise<void> {
  if (await refuseIfUnauthorized(ctx, msgId, auth)) return
  const ownerContactId = await resolveOwnerForChat(ctx, sourceChatId)
  if (!ownerContactId) {
    await sendChatFailed(msgId, ctx, "I can't tell who owns this chat — try unpairing and re-pairing.")
    return
  }
  try {
    const defaultAgent = agents.ensureDefaultAgent()
    const newChatId = await createReuseChat(ctx, defaultAgent, ownerContactId)
    ctx.logf('agent-setup: default-chat bound %s to chat %d for owner %d', defaultAgent.name, newChatId, ownerContactId)
    await sendChatReady(msgId, ctx, newChatId, sourceChatId)
  } catch (err) {
    ctx.logf('agent-setup: start-default-chat failed: %v', err)
    await sendChatFailed(msgId, ctx, err instanceof Error ? err.message : 'unknown error')
  }
}

/**
 * §6-gated: reuse an existing agent in a NEW DC chat from the mode picker
 * (replies `chat-ready`/`chat-failed`). On a refused auth result it emits
 * `action_err`. Extracted from the monolith's `start-reuse-chat` branch.
 */
export async function handleStartReuseChat(
  ctx: AppContext,
  msgId: number,
  sourceChatId: number,
  agentId: string,
  auth: ControlAuth,
): Promise<void> {
  if (await refuseIfUnauthorized(ctx, msgId, auth)) return
  if (!agentId) {
    await sendChatFailed(msgId, ctx, 'Missing agent id.')
    return
  }
  const agent = agents.getAgent(agentId)
  if (!agent) {
    await sendChatFailed(msgId, ctx, `Agent "${agentId}" no longer exists.`)
    return
  }
  const ownerContactId = await resolveOwnerForChat(ctx, sourceChatId)
  if (!ownerContactId) {
    await sendChatFailed(msgId, ctx, "I can't tell who owns this chat — try unpairing and re-pairing.")
    return
  }
  try {
    const newChatId = await createReuseChat(ctx, agent, ownerContactId)
    ctx.logf('agent-setup: reuse-chat bound %s to chat %d for owner %d', agent.name, newChatId, ownerContactId)
    await sendChatReady(msgId, ctx, newChatId, sourceChatId)
  } catch (err) {
    ctx.logf('agent-setup: start-reuse-chat failed for agent %s: %v', agentId, err)
    await sendChatFailed(msgId, ctx, err instanceof Error ? err.message : 'unknown error')
  }
}

/**
 * §6-gated: re-point the CURRENT chat to a different agent in place (#86 —
 * replies `chat-ready`/`chat-failed`). On a refused auth result it emits
 * `action_err`. Extracted from the monolith's `rebind-chat` dispatch branch.
 */
export async function handleRebindChat(
  ctx: AppContext,
  msgId: number,
  sourceChatId: number,
  agentId: string,
  keepContext: boolean,
  auth: ControlAuth,
): Promise<void> {
  if (await refuseIfUnauthorized(ctx, msgId, auth)) return
  if (!agentId) {
    await sendChatFailed(msgId, ctx, 'Missing agent id.')
    return
  }
  const agent = agents.getAgent(agentId)
  if (!agent) {
    await sendChatFailed(msgId, ctx, `Agent "${agentId}" no longer exists.`)
    return
  }
  try {
    await rebindChat(ctx, sourceChatId, agent, { keepContext })
    ctx.logf('agent-setup: rebound chat %d -> %s (keepContext=%s)', sourceChatId, agentId, String(keepContext))
    await sendChatReady(msgId, ctx, sourceChatId, sourceChatId)
  } catch (err) {
    ctx.logf('agent-setup: rebind-chat failed for agent %s: %v', agentId, err)
    await sendChatFailed(msgId, ctx, err instanceof Error ? err.message : 'unknown error')
  }
}
