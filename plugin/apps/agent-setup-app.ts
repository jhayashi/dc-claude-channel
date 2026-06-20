/**
 * Agent setup WebXDC app — sends a setup card into a paired chat that
 * lets the user pick an existing agent to reuse OR create a new one
 * from scratch. On confirm, creates a new DC chat (if needed) and
 * persists an agent definition + binding per the 2026-04-09 spec.
 */

import type { WebXDCApp, ToolDef, ToolResult, AppContext } from '../webxdc-app.js'
import type { WebXDCUpdate } from '../dc-client.js'
import * as agentSetup from '../agent-setup.js'
import * as agents from '../agents.js'
import * as models from '../models.js'
import * as bindings from '../bindings.js'
import * as access from '../access/index.js'
import { loadAllLeaves, symmetricCombines, getDefaultCatalog, type Catalog, type Leaf, type Path } from '../leaves.js'
import { decideCleanup, CONTACT_SELF } from '../cleanup.js'
import { ALL_BUILTIN_TOOLS, BUILTIN_TOOL_DESCRIPTIONS } from '../dispatcher/subagent-process.js'
import { startCoach, advanceCoach, isCoachDone, collectAnswers, type CoachState, type CoachAnswers } from '../coach.js'
import { assembleSystemPrompt } from '../prompt-assembler.js'
import { PATTERN_IDS, type PatternId } from '../agent-icons/palettes.js'
import { logLifecycleEvent } from '../events-lifecycle.js'
import { logRoleAssignment } from '../events.js'
import * as sessionAgents from '../session-agents.js'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

function availableToolsPayload(ctx: AppContext) {
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

function buildL2Summary(leaves: Leaf[]): L2Summary[] {
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
   * Snapshot of agent-setup.html's APP_VERSION at the time the card was
   * sent to this chat. Used by sendInit to decide whether the existing
   * card is current. Pre-2026-05-31 sessions don't have this field
   * (undefined), which shouldResendCard treats as stale so the user
   * lands on the fresh HTML immediately instead of going through the
   * version_mismatch round-trip.
   */
  appVersion?: number
}

/**
 * Decide whether `dc_open_agent_settings` (and the dispatcher-side
 * sendInit closure) should send a *new* xdc card to the chat, or just
 * push a status update to the existing one.
 *
 * Pre-fix sendInit always reused the existing session if one existed,
 * which forced the user through the version_mismatch flow after a
 * release: their old card detected the higher server version, fired
 * version_mismatch, the dispatcher re-spawned a fresh card, and the
 * user saw "outdated, upgrading…" UI flash on the old card.
 *
 * The fix: track appVersion per session and only reuse when the
 * recorded version matches the current on-disk HTML version.
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
 * Pure parser for the sessions-on-disk JSON. Extracted from
 * loadSessions so the load path is unit-testable without a real
 * filesystem. Returns an empty array on malformed/missing/non-array
 * input — never throws.
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

// Per-chat msgId pointer: "has this chat seen the setup card yet, and if so,
// which msgId?" First dc_open_agent_settings call sends a new xdc; later calls
// send a status update to the same msgId so the card returns to the top via
// the info notification. No flow state lives here — the card always opens on
// home.
//
// Persisted to disk so `bun server.ts` restarts don't orphan existing cards
// (which would silently drop user interactions — every sent update arrives
// at onWebXDCUpdate with a msgId the central registry doesn't know about).
const sessions = new Map<number, Session>()

const SESSIONS_FILE = join(homedir(), '.claude', 'channels', 'deltachat', 'agent-setup-sessions.json')

function persistSessions(): void {
  try {
    mkdirSync(join(homedir(), '.claude', 'channels', 'deltachat'), { recursive: true })
    const array = Array.from(sessions.values())
    writeFileSync(SESSIONS_FILE, JSON.stringify(array, null, 2))
  } catch {
    // Non-fatal: worst case, next restart orphans these cards. Log via ctx
    // isn't available here; silent swallow is acceptable since the caller
    // already logged the successful send.
  }
}

function loadSessions(): Session[] {
  if (!existsSync(SESSIONS_FILE)) return []
  try {
    return parseSessions(readFileSync(SESSIONS_FILE, 'utf-8'))
  } catch {
    return []
  }
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

/** Baseline draft for a fresh "create agent" form. The client populates
 *  these values when the user navigates to the create screen from home. */
function blankDraft(): agents.DraftAgent {
  return {
    name: 'New agent',
    model: agents.DEFAULT_MODEL,
    description: '',
    system: agents.DEFAULT_SYSTEM_PROMPT,
    tools: [],
  }
}

/** Summarize agents for the picker screen. */
async function listExistingForPicker(sourceChatId: number): Promise<Array<{ id: string; name: string; model: string; archetype: string; icon: string; glyph: string; pattern: PatternId; tier: string; isTrusted: boolean; iconDataUri: string; bindingCount: number; isCurrentAgent: boolean; isUndeletable: boolean }>> {
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

/**
 * Proactively detect dead chats (owner left or chat deleted locally)
 * that the event-based cleanup missed. Uses getFullChat to check
 * contactIds (current members) and pastContactIds (former members).
 *
 * A chat is swept if:
 *   1. The bot is no longer a member (bot-removed), OR
 *   2. The bot is the only current member (bot-alone), OR
 *   3. The chat can no longer send (canSend=false).
 *
 * Called before building the manage-screen payload so binding counts
 * are accurate.
 */
async function sweepDeadChats(ctx: AppContext): Promise<void> {
  for (const b of bindings.listBindings()) {
    if (!access.isAllowed(b.chatId)) continue
    try {
      const fc = await ctx.client.getFullChat(b.chatId)
      const decision = decideCleanup('ChatModified', fc.contactIds)
      if (decision.cleanup) {
        bindings.deleteBinding(b.chatId)
        access.removeChat(b.chatId)
        ctx.logf('agent-setup: swept dead chat %d (%s) contacts=%v past=%v',
          b.chatId, decision.reason, fc.contactIds, fc.pastContactIds)
        continue
      }
      if (!fc.canSend) {
        bindings.deleteBinding(b.chatId)
        access.removeChat(b.chatId)
        ctx.logf('agent-setup: swept unsendable chat %d canSend=false', b.chatId)
        continue
      }
      ctx.logf('agent-setup: sweep kept chat %d agent=%s contacts=%v past=%v canSend=%v selfInGroup=%v',
        b.chatId, b.agentId ?? 'none', fc.contactIds, fc.pastContactIds, fc.canSend, fc.selfInGroup)
    } catch (err) {
      ctx.logf('agent-setup: sweep check failed chat %d: %v', b.chatId, err)
    }
  }
}

async function sendInit(
  ctx: AppContext,
  app: WebXDCApp,
  sourceChatId: number,
): Promise<Session> {
  await sweepDeadChats(ctx)
  const existing = sessions.get(sourceChatId)
  const currentVersion = agentSetup.getAgentSetupVersion()
  const draft = blankDraft()
  const leaves = loadAllLeaves()
  const sym = symmetricCombines()
  const payload = {
    type: 'init' as const,
    version: currentVersion,
    draft: {
      ...draft,
      skipPermissions: agents.getSkipPermissions(draft as agents.AgentDef),
      memoryBoost: agents.memoryBoostEnabled(draft as agents.AgentDef),
      iconMirror: agents.getIconMirror(draft as agents.AgentDef),
    },
    existingAgents: await listExistingForPicker(sourceChatId),
    senderAddr: 'server',
    availableModels: models.MODELS.map(m => ({ id: m.id, label: m.label, tier: m.tier })),
    defaultModel: models.DEFAULT_MODEL,
    ...availableToolsPayload(ctx),
    newAgentFlow: {
      leaves: leaves.map(l => ({
        id: l.id,
        path: l.path,
        l2: l.l2,
        name: l.name,
        parameter: l.parameter,
        liability: l.liability,
        pitch: l.pitch,
        combinesWith: [...(sym.get(l.id) ?? new Set<string>())].sort(),
      })),
      l2Summary: buildL2Summary(leaves),
    },
  }
  const update = JSON.stringify({
    payload,
    summary: 'Agent setup',
    info: 'Tap to open agent settings',
    href: 'index.html',
  })

  // 2026-05-31 (Joe chat 14 msg 8916+): reuse the existing card only when its
  // recorded appVersion matches the current on-disk HTML version. Otherwise
  // we'd be pushing an update to a STALE card that would then fire
  // version_mismatch and force the user through the "outdated, upgrading…"
  // flow. shouldResendCard codifies the decision (see helper for the table).
  if (existing && !shouldResendCard(existing, currentVersion)) {
    await ctx.client.sendWebXDCUpdate(existing.msgId, update)
    return existing
  }

  const { xdcPath } = await agentSetup.buildAgentSetupXDC()
  const msgId = await ctx.client.sendWebXDC(sourceChatId, xdcPath)
  try {
    const { unlinkSync } = await import('node:fs')
    unlinkSync(xdcPath)
  } catch {}
  await ctx.client.sendWebXDCUpdate(msgId, update)
  // Drop the old session BEFORE setting the new one — the old msgId is now
  // stale (we just sent a replacement) and must be unregistered so future
  // taps on it route to the version_mismatch fallback path, not the active
  // session.
  if (existing) {
    ctx.unregisterWebXDCMsg(existing.msgId)
  }
  const session: Session = { msgId, sourceChatId, appVersion: currentVersion }
  sessions.set(sourceChatId, session)
  persistSessions()
  ctx.registerWebXDCMsg(msgId, app, sourceChatId)
  ctx.logf(
    'agent-setup: sent app (msg %d, version %s) to chat %d%s',
    msgId, currentVersion, sourceChatId,
    existing ? ` (replacing stale msg ${existing.msgId})` : '',
  )
  return session
}

/**
 * Public entry point for other apps (e.g. permissions) that want to
 * summon the agent settings card into a chat. Equivalent to the subagent
 * calling `dc_open_agent_settings` but callable from the dispatcher side.
 */
export async function summonAgentSettings(ctx: AppContext, chatId: number): Promise<void> {
  await sendInit(ctx, agentSetupApp, chatId)
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

/** Apply icon + intro message after a chat has been bound to an agent. */
export async function decorateAgentChat(
  ctx: DecorateContext,
  chatId: number,
  agent: agents.AgentDef,
): Promise<void> {
  try {
    await setAgentIcon(ctx, chatId, agent)
  } catch (err) {
    ctx.logf('agent-setup: set icon failed: %v', err)
  }

  try {
    await ctx.client.send(
      chatId,
      `Hi! This is your new "${agentDisplayName(agent)}" agent. Send a message here to get started.`,
    )
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
  const indexed = sessionAgents.getAgentForSession(sessionId)
  const sourceBinding = bindings.getBinding(sourceChatId)
  return indexed ?? sourceBinding?.agentId ?? agents.DEFAULT_AGENT_ID
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
  await decorateAgentChat(ctx, newChatId, agent)
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
): Promise<void> {
  const current = bindings.getBinding(sourceChatId)
  if (current?.agentId === agent.name) {
    throw new Error('This chat is already on that agent.')
  }
  bindings.clearSessionId(sourceChatId)   // fresh CC session for the new agent
  bindings.bindAgent(sourceChatId, agent.name, {
    inheritClaudeMd: agents.inheritClaudeMdForModel(agent.model),
  })
  await ctx.evictSubagent(sourceChatId)   // next message picks up the new .md
  // Decoration is cosmetic (avatar swap + intro line). The rebind already
  // took effect above, so don't fail it — and mislead the user into a retry
  // that hits the same-agent guard — over a badge/send hiccup.
  try {
    await decorateAgentChat(ctx, sourceChatId, agent)
  } catch (err) {
    ctx.logf('agent-setup: rebind decorate failed chat=%d: %v', sourceChatId, err)
  }
}

/**
 * Reply to a Phase-12 mode-picker flow on the source setup card with the
 * new chat's id. The card listens for chat-ready in setUpdateListener,
 * closes the confirmation modal, and routes back to the home screen.
 */
async function sendChatReady(
  session: Session,
  ctx: AppContext,
  newChatId: number,
): Promise<void> {
  const update = JSON.stringify({
    payload: { type: 'chat-ready', chatId: newChatId, senderAddr: 'server' },
    summary: 'Chat created',
  })
  try {
    await ctx.client.sendWebXDCUpdate(session.msgId, update)
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
  session: Session,
  ctx: AppContext,
  error: string,
): Promise<void> {
  const update = JSON.stringify({
    payload: { type: 'chat-failed', error, senderAddr: 'server' },
    summary: 'Chat creation failed',
  })
  try {
    await ctx.client.sendWebXDCUpdate(session.msgId, update)
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
        "Sorry — I couldn't finish setting up your agent. Tap the agent settings card to try again.",
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

export async function handleListContacts(ctx: AppContext, msgId: number, sourceChatId: number): Promise<void> {
  // v1.4.9: the managed agent context for the Contacts UI is the agent
  // bound to the chat the agent-setup app was opened from. For an
  // unbound source chat (rare — opening Manage from a fresh DC chat),
  // getBindingAgentId falls back to claude-code so we show *something*
  // sensible rather than an empty UI.
  const managedAgentId = bindings.getBindingAgentId(sourceChatId)

  // Phase 4 (D3 — Knob 1 b): the picker universe is the members of
  // chats *bound to the managed agent*, not the bot's full address
  // book. Avoids cross-agent visibility leaks (e.g., a contact you
  // only know via librarian doesn't pollute dc-developer's role
  // picker). Pre-v1.4.9 the universe was `client.getChats()` (all
  // bot chats); the narrowing is the user-visible Phase 4 change.
  //
  // dc-core's getChatContacts filters add_timestamp >= remove_timestamp, so
  // ex-members (e.g. someone removed from a chat) are automatically
  // excluded. Using getContactIds instead would return phantom contacts
  // dc-core knows about via Autocrypt-Gossip but isn't currently chatting
  // with — Joe explicitly does NOT want those in the picker.
  const chatIds = bindings.listBindings()
    .filter(b => b.agentId === managedAgentId)
    .map(b => b.chatId)
  const seen = new Set<number>()
  for (const chatId of chatIds) {
    let members: number[] = []
    try { members = await ctx.client.getChatContacts(chatId) } catch { continue }
    for (const id of members) {
      if (id <= 9) continue // CONTACT_SELF (1) + DC reserved range (≤9)
      seen.add(id)
    }
  }

  const ownAddr = await ctx.client.getSelfAddress()

  const enriched = await Promise.all(Array.from(seen).map(async (contactId) => {
    let record: access.Contact | null = null
    try { record = access.loadContact(managedAgentId, contactId) } catch { /* corrupt → treat as unpaired */ }
    const info = await ctx.client.getContact(contactId)
    return {
      contactId,
      kind: 'human' as const,
      firstPairedAt: record?.firstPairedAt ?? null,
      role: record?.role ?? null,
      capabilities: record?.capabilities ?? null,
      displayName: info?.displayName ?? null,
      chatmailAddress: info?.address ?? null,
      isBot: info?.isBot ?? false,
    }
  }))

  // Bots are intentionally NOT filtered: we want to be able to permission
  // other DC bots (research bot → trusted-agent, third-party bot →
  // untrusted-agent, etc.). The only defensive filter is matching the
  // dispatcher's own address — that catches self-as-contact ghosts.
  const filtered = ownAddr
    ? enriched.filter(c => c.chatmailAddress !== ownAddr)
    : enriched

  await ctx.client.sendWebXDCUpdate(msgId, JSON.stringify({ payload: { type: 'contacts_loaded', contacts: filtered } }))
}

export async function handleAssignRole(
  ctx: AppContext,
  msgId: number,
  sourceChatId: number,
  contactId: number | null,
  role: string | null,
  senderAddr: string | null,
): Promise<void> {
  if (!contactId || !role) return
  // v1.4.9: write the role assignment to the *managed agent's* sidecar
  // (the agent bound to the chat the picker was launched from), not to
  // the canonical claude-code namespace. This makes per-agent role
  // divergence real: contact 11 can be subscriber for dc-developer and
  // family-member for librarian.
  const managedAgentId = bindings.getBindingAgentId(sourceChatId)

  // No early-return on unpaired contacts: per Option B the picker is the
  // path to first-time role assignment, so a missing record is expected
  // and setContactRole creates one with firstPairedAt = now.
  let previous: access.Contact | null = null
  try { previous = access.loadContact(managedAgentId, contactId) } catch { /* corrupt → treat as no prior */ }

  const assignerContactId = senderAddr
    ? await ctx.client.lookupContactByAddr(senderAddr)
    : null

  const updated = access.setContactRole(managedAgentId, contactId, role)
  logRoleAssignment({
    ts: new Date().toISOString(),
    assigneeContactId: contactId,
    assignedRole: role,
    previousRole: previous?.role ?? null,
    assignerContactId,
    reason: 'picked',
  })
  const info = await ctx.client.getContact(contactId)
  const enriched = {
    ...updated,
    displayName: info?.displayName ?? null,
    chatmailAddress: info?.address ?? null,
  }
  await ctx.client.sendWebXDCUpdate(msgId, JSON.stringify({ payload: { type: 'role_assigned', contact: enriched } }))
}

export const agentSetupApp: WebXDCApp = {
  id: 'agent-setup',

  start(ctx: AppContext): void {
    const saved = loadSessions()
    for (const s of saved) {
      if (s.lastSerial == null) s.needsSerialSeed = true
      sessions.set(s.sourceChatId, s)
      ctx.registerWebXDCMsg(s.msgId, agentSetupApp, s.sourceChatId, s.lastSerial)
    }
    if (saved.length > 0) {
      ctx.logf('agent-setup: rehydrated %d session(s) from disk (%d need serial seed)',
        saved.length, saved.filter(s => s.needsSerialSeed).length)
    }
  },

  instructions:
    'AGENT SETTINGS APP:\n' +
    '1. The agent settings app is a self-contained UI where the user manages ' +
    'their agents, starts new chats, and resumes terminal sessions. Call ' +
    'dc_open_agent_settings to surface it whenever the user mentions ANY of: ' +
    'creating a new agent, starting a new chat, editing/deleting/managing ' +
    'agents, "agent app", "agent card", "settings app", "send me the app", ' +
    '"change the model", "change my prompt", "edit this agent", "teleport", ' +
    '"import terminal session", "resume a session". The app always opens on ' +
    'its home screen — the user picks what they want to do from there.\n' +
    '2. Do NOT build or send agent-setup.xdc yourself via Bash/dc_send_webxdc. ' +
    'Do NOT read agent-setup.ts or agent-setup-app.ts. Do NOT read or edit ' +
    'agent YAML files. dc_open_agent_settings is the only supported path.\n' +
    '3. Do NOT offer to change agent settings through conversation — send ' +
    'the app instead.',

  tools(): ToolDef[] {
    return [
      {
        name: 'dc_open_agent_settings',
        requiresCapability: 'chat',
        description:
          'Surface the Agent settings app in the user\'s chat. The app always ' +
          'opens on a home screen where the user chooses what to do: start a ' +
          'new chat with an agent, manage (edit / delete / export) existing ' +
          'agents, or resume a terminal session. Call this whenever the user ' +
          'asks about agents, new chats, resuming a terminal session, or anything ' +
          'else that belongs in the settings UI — the app handles all of it.',
        inputSchema: {
          type: 'object',
          properties: {
            source_chat_id: {
              type: 'string',
              description: 'The chat the user is messaging from (where to surface the settings app).',
            },
          },
          required: ['source_chat_id'],
        },
      },
    ]
  },

  async callTool(name: string, args: Record<string, unknown>, ctx: AppContext): Promise<ToolResult | null> {
    if (name !== 'dc_open_agent_settings') return null

    const sourceChatId = Number(args.source_chat_id as string)
    if (!sourceChatId || Number.isNaN(sourceChatId)) {
      return { content: [{ type: 'text', text: 'dc_open_agent_settings: invalid source_chat_id' }], isError: true }
    }
    if (!ctx.isAllowed(sourceChatId)) {
      return { content: [{ type: 'text', text: `dc_open_agent_settings: chat ${sourceChatId} not allowed` }], isError: true }
    }

    try {
      await sendInit(ctx, agentSetupApp, sourceChatId)
    } catch (err) {
      ctx.logf('agent-setup: send failed: %v', err)
      return { content: [{ type: 'text', text: `dc_open_agent_settings: send failed: ${(err as Error).message}` }], isError: true }
    }

    return {
      content: [{
        type: 'text',
        text: `Agent settings app surfaced in chat ${sourceChatId}.`,
      }],
    }
  },

  async onWebXDCUpdate(msgId: number, updates: WebXDCUpdate[], ctx: AppContext): Promise<void> {
    // Find the session for this msgId.
    let session: Session | null = null
    for (const s of sessions.values()) {
      if (s.msgId === msgId) { session = s; break }
    }
    if (!session) return

    // Migration guard: sessions loaded from disk without a persisted
    // lastSerial (pre-fix) would replay every old create/bind action on
    // the first update batch. Instead, seed the serial from the batch
    // and skip processing — the next batch will be new updates only.
    if (session.needsSerialSeed) {
      const maxSerial = updates.reduce((m, u) => Math.max(m, u.serial ?? 0), 0)
      session.lastSerial = maxSerial
      delete session.needsSerialSeed
      persistSessions()
      ctx.logf('agent-setup: seeded serial %d for chat %d (migration)', maxSerial, session.sourceChatId)
      return
    }

    for (const u of updates) {
      const payload = u.payload as {
        type?: string
        config?: unknown
        agentId?: string
        inheritClaudeMd?: boolean
        appVersion?: number
        serverVersion?: number
      } | null
      if (!payload) continue

      if (payload.type === 'version_mismatch') {
        // Guard against double-handling.
        const current = sessions.get(session.sourceChatId)
        if (!current || current.msgId !== msgId) return
        ctx.logf('agent-setup: version mismatch from chat %d, resending app', session.sourceChatId)
        ctx.unregisterWebXDCMsg(msgId)
        sessions.delete(session.sourceChatId)
        try {
          await sendInit(ctx, agentSetupApp, session.sourceChatId)
        } catch (err) {
          ctx.logf('agent-setup: resend after version mismatch failed: %v', err)
        }
        return
      }

      // Resolve the owner contact for the new chat (1:1 source: extract from
      // contacts; group source: use the stored owner).
      const resolveOwner = async (): Promise<number | null> => {
        let ownerContactId = access.firstPermissionedContact(session!.sourceChatId)
        if (ownerContactId) return ownerContactId
        try {
          const contacts = await ctx.client.getChatContacts(session!.sourceChatId)
          const found = contacts.find(id => id !== 1)
          if (!found) {
            ctx.logf('agent-setup: could not find contact in source chat %d', session!.sourceChatId)
            return null
          }
          return found
        } catch (err) {
          ctx.logf('agent-setup: getChatContacts failed for chat %d: %v', session!.sourceChatId, err)
          return null
        }
      }

      if (payload.type === 'build-agent') {
        const rawLeafIds = (payload as { leafIds?: unknown }).leafIds
        if (!Array.isArray(rawLeafIds) || rawLeafIds.length === 0) {
          await sendChatFailed(session, ctx, 'No specialties were sent.')
          continue
        }
        const leafIds = rawLeafIds.filter((x): x is string => typeof x === 'string' && x.length > 0)
        if (leafIds.length === 0) {
          await sendChatFailed(session, ctx, 'No specialties were sent.')
          continue
        }
        // Phase 9.2: pattern picker on review screen. Validate against
        // PATTERN_IDS — fall back to 'checker' if missing or unknown so a
        // stale client (pre-1.93) still graduates with a sensible default.
        const rawPattern = (payload as { pattern?: unknown }).pattern
        const validPattern: PatternId =
          typeof rawPattern === 'string' && (PATTERN_IDS as readonly string[]).includes(rawPattern)
            ? (rawPattern as PatternId)
            : 'checker'
        try {
          const newChatId = await handleBuildAgent(ctx, session.sourceChatId, leafIds, validPattern, resolveOwner)
          await sendChatReady(session, ctx, newChatId)
        } catch (err) {
          ctx.logf('agent-setup: build-agent failed: %v', err)
          await sendChatFailed(session, ctx, err instanceof Error ? err.message : 'unknown error')
        }
        continue
      }

      if (payload.type === 'editRequest') {
        // Edit an existing agent. Re-open the setup card with the agent pre-filled.
        const agentId = typeof payload.agentId === 'string' ? payload.agentId : ''
        if (!agentId) {
          ctx.logf('agent-setup: edit payload missing agentId')
          continue
        }
        const agent = agents.getAgent(agentId)
        if (!agent) {
          ctx.logf('agent-setup: edit requested agent %s not found', agentId)
          continue
        }
        const editDraft = legacyDraftFromAgent(agent)
        try {
          const update = JSON.stringify({
            payload: {
              type: 'edit',
              draft: editDraft,
              version: agentSetup.getAgentSetupVersion(),
              senderAddr: 'server',
              availableModels: models.MODELS.map(m => ({ id: m.id, label: m.label, tier: m.tier })),
              defaultModel: models.DEFAULT_MODEL,
              ...availableToolsPayload(ctx),
            },
            summary: 'Editing agent',
          })
          await ctx.client.sendWebXDCUpdate(session.msgId, update)
          ctx.logf('agent-setup: sent edit screen for agent %s', agentId)
        } catch (err) {
          ctx.logf('agent-setup: edit send failed: %v', err)
        }
        continue
      }

      if (payload.type === 'delete') {
        const agentId = typeof payload.agentId === 'string' ? payload.agentId : ''
        if (!agentId) {
          ctx.logf('agent-setup: delete payload missing agentId')
          continue
        }
        if (agents.isUndeletableAgent(agentId)) {
          ctx.logf('agent-setup: refusing to delete built-in default agent %s', agentId)
          continue
        }
        const agent = agents.getAgent(agentId)
        if (!agent) {
          ctx.logf('agent-setup: delete requested agent %s not found', agentId)
          continue
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
              existingAgents: await listExistingForPicker(session.sourceChatId),
              version: agentSetup.getAgentSetupVersion(),
              senderAddr: 'server',
            },
            summary: 'Agent deleted',
          })
          await ctx.client.sendWebXDCUpdate(session.msgId, update)
          // Keep the session alive — user stays on the main screen
          // and may want to delete/edit more agents.
        } catch (err) {
          ctx.logf('agent-setup: delete failed: %v', err)
        }
        continue
      }

      if (payload.type === 'export') {
        const agentId = typeof payload.agentId === 'string' ? payload.agentId : ''
        if (!agentId) {
          ctx.logf('agent-setup: export payload missing agentId')
          continue
        }
        const agent = agents.getAgent(agentId)
        if (!agent) {
          ctx.logf('agent-setup: export requested agent %s not found', agentId)
          try {
            const update = JSON.stringify({
              payload: {
                type: 'exportError',
                message: 'Agent no longer exists.',
                version: agentSetup.getAgentSetupVersion(),
                senderAddr: 'server',
              },
              summary: 'Export failed',
            })
            await ctx.client.sendWebXDCUpdate(session.msgId, update)
          } catch (err) {
            ctx.logf('agent-setup: export error update failed: %v', err)
          }
          continue
        }
        try {
          const { writeFileSync, unlinkSync, mkdtempSync } = await import('node:fs')
          const { join } = await import('node:path')
          const { tmpdir } = await import('node:os')
          const YAML = (await import('yaml')).default

          const yamlStr = YAML.stringify(agent)
          const dir = mkdtempSync(join(tmpdir(), 'dc-agent-export-'))
          const filePath = join(dir, `${agentId}.yaml`)
          writeFileSync(filePath, yamlStr)

          await ctx.client.sendAttachment(
            session.sourceChatId,
            filePath,
            `Exported agent "${agent.name}"`,
          )
          ctx.logf('agent-setup: exported agent %s to chat %d', agentId, session.sourceChatId)

          // Notify the card so it can reset the button state.
          const update = JSON.stringify({
            payload: {
              type: 'exported',
              agentId,
              version: agentSetup.getAgentSetupVersion(),
              senderAddr: 'server',
            },
            summary: 'Agent exported',
          })
          await ctx.client.sendWebXDCUpdate(session.msgId, update)

          // Clean up temp file.
          try { unlinkSync(filePath) } catch {}
        } catch (err) {
          ctx.logf('agent-setup: export failed for agent %s: %v', agentId, err)
        }
        continue
      }

      if (payload.type === 'saveEdit') {
        // Legacy WebXDC form contract — full rewrite is Slice 6. This handler
        // adapts the v1.3-shape payload onto the v1.4 AgentDef in-memory shape.
        const agentId = typeof payload.agentId === 'string' ? payload.agentId : ''
        if (!agentId) {
          ctx.logf('agent-setup: saveEdit missing agentId')
          continue
        }
        const agent = agents.getAgent(agentId)
        if (!agent) {
          ctx.logf('agent-setup: saveEdit requested agent %s not found', agentId)
          continue
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
              existingAgents: await listExistingForPicker(session.sourceChatId),
              version: agentSetup.getAgentSetupVersion(),
              senderAddr: 'server',
            },
            summary: 'Agent updated',
          })
          await ctx.client.sendWebXDCUpdate(session.msgId, update)
          // Keep the session alive — user stays on the main screen.
        } catch (err) {
          ctx.logf('agent-setup: saveEdit failed: %v', err)
        }
        continue
      }

      if (payload.type === 'bind') {
        // Reuse an existing agent definition in a new DC chat.
        const agentId = typeof payload.agentId === 'string' ? payload.agentId : ''
        if (!agentId) {
          ctx.logf('agent-setup: bind payload missing agentId')
          continue
        }
        const agent = agents.getAgent(agentId)
        if (!agent) {
          ctx.logf('agent-setup: bind requested agent %s not found', agentId)
          continue
        }
        const ownerContactId = await resolveOwner()
        if (!ownerContactId) continue

        try {
          const newChatId = await ctx.client.createGroup(agent.name)
          await ctx.client.addContactToChat(newChatId, ownerContactId)
          access.addChat(newChatId, ownerContactId)
          bindings.bindAgent(newChatId, agent.name, {
            inheritClaudeMd: agents.inheritClaudeMdForModel(agent.model),
          })
          await decorateAgentChat(ctx, newChatId, agent)
          ctx.logf('agent-setup: bound existing agent %s to new chat %d for owner %d', agent.name, newChatId, ownerContactId)

          const update = JSON.stringify({
            payload: { type: 'created', chatId: newChatId, name: agent.name },
            summary: 'Agent created',
          })
          await ctx.client.sendWebXDCUpdate(session.msgId, update)
          // Session stays alive — user may keep using the settings card.
        } catch (err) {
          ctx.logf('agent-setup: bind failed: %v', err)
        }
        continue
      }

      // Phase 12 — reuse-an-agent flow from the new mode picker. Same
      // chat-create + bind sequence as the legacy `bind` handler above,
      // but emits chat-ready / chat-failed (which the modal listens for)
      // instead of `created` (which closes the create-form flow). Kept
      // as a separate payload type so future divergence (e.g. richer
      // processing-state UX) doesn't have to thread through the legacy
      // path.
      // Phase 12 — default-agent quick path. Same chat-create flow as
      // start-reuse-chat, but the agent is the built-in default
      // (auto-seeded by ensureDefaultAgent on first use). The default
      // is editable / deletable via Manage like any other agent;
      // tapping this card again just re-seeds and creates another chat.
      if (payload.type === 'start-default-chat') {
        const ownerContactId = await resolveOwner()
        if (!ownerContactId) {
          await sendChatFailed(session, ctx, "I can't tell who owns this chat — try unpairing and re-pairing.")
          continue
        }
        try {
          const defaultAgent = agents.ensureDefaultAgent()
          const newChatId = await createReuseChat(ctx, defaultAgent, ownerContactId)
          ctx.logf('agent-setup: default-chat bound %s to chat %d for owner %d', defaultAgent.name, newChatId, ownerContactId)
          await sendChatReady(session, ctx, newChatId)
        } catch (err) {
          ctx.logf('agent-setup: start-default-chat failed: %v', err)
          await sendChatFailed(session, ctx, err instanceof Error ? err.message : 'unknown error')
        }
        continue
      }

      if (payload.type === 'start-reuse-chat') {
        const agentId = typeof payload.agentId === 'string' ? payload.agentId : ''
        if (!agentId) {
          await sendChatFailed(session, ctx, 'Missing agent id.')
          continue
        }
        const agent = agents.getAgent(agentId)
        if (!agent) {
          await sendChatFailed(session, ctx, `Agent "${agentId}" no longer exists.`)
          continue
        }
        const ownerContactId = await resolveOwner()
        if (!ownerContactId) {
          await sendChatFailed(session, ctx, "I can't tell who owns this chat — try unpairing and re-pairing.")
          continue
        }
        try {
          const newChatId = await createReuseChat(ctx, agent, ownerContactId)
          ctx.logf('agent-setup: reuse-chat bound %s to chat %d for owner %d', agent.name, newChatId, ownerContactId)
          await sendChatReady(session, ctx, newChatId)
        } catch (err) {
          ctx.logf('agent-setup: start-reuse-chat failed for agent %s: %v', agentId, err)
          await sendChatFailed(session, ctx, err instanceof Error ? err.message : 'unknown error')
        }
        continue
      }

      if (payload.type === 'rebind-chat') {
        const agentId = typeof payload.agentId === 'string' ? payload.agentId : ''
        if (!agentId) {
          await sendChatFailed(session, ctx, 'Missing agent id.')
          continue
        }
        const agent = agents.getAgent(agentId)
        if (!agent) {
          await sendChatFailed(session, ctx, `Agent "${agentId}" no longer exists.`)
          continue
        }
        try {
          await rebindChat(ctx, session.sourceChatId, agent)
          ctx.logf('agent-setup: rebound chat %d -> %s', session.sourceChatId, agentId)
          await sendChatReady(session, ctx, session.sourceChatId)
        } catch (err) {
          ctx.logf('agent-setup: rebind-chat failed for agent %s: %v', agentId, err)
          await sendChatFailed(session, ctx, err instanceof Error ? err.message : 'unknown error')
        }
        continue
      }

      if (payload.type === 'create') {
        const parsed = agents.DraftAgentSchema.safeParse(payload.config)
        if (!parsed.success) {
          ctx.logf('agent-setup: invalid config from chat %d: %v', session.sourceChatId, parsed.error)
          continue
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
        const ownerContactId = await resolveOwner()
        if (!ownerContactId) continue

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
            const savedAgent = agents.getAgent(agentId)
            if (savedAgent) await decorateAgentChat(ctx, newChatId, savedAgent)
            ctx.logf('agent-setup: created agent %s for chat %d (owner %d)', agentId, newChatId, ownerContactId)
          } else {
            ctx.logf('agent-setup: created agent %s (library only, no chat) (owner %d)', agentId, ownerContactId)
          }

          const update = JSON.stringify({
            payload: { type: 'created', chatId: newChatId, name: draft.name, skipChat },
            summary: 'Agent created',
          })
          await ctx.client.sendWebXDCUpdate(session.msgId, update)
          // For skipChat, explicitly re-fire init so the Manage screen's
          // existingAgents list refreshes with the new entry. The legacy
          // chat-creating path doesn't need this because the user navigates
          // to the new chat (where state restarts fresh).
          if (skipChat) {
            await sendInit(ctx, agentSetupApp, session.sourceChatId)
          }
          // Session stays alive — user may keep using the settings card.
        } catch (err) {
          ctx.logf('agent-setup: create failed: %v', err)
          // Roll back the agent file if it was written but binding failed.
          try { agents.deleteAgent(agentId) } catch {}
        }
      }

      // Contact management dispatcher branches — restored 2026-05-30 after
      // commit 9035b34 (2026-05-03 "retire legacy new-chat and Paired devices
      // views") inadvertently stripped them alongside the legacy view cleanup.
      // Both client senders still exist (openContacts → list_contacts,
      // role-picker Save → assign_role) and both handlers are unit-tested,
      // but the wire from this dispatch loop was severed for ~27 days,
      // silently producing an empty Contacts UI on every agent's overflow
      // menu. See structural regression guards in test/agent-setup-app.test.ts.
      if (payload.type === 'list_contacts') {
        await handleListContacts(ctx, session.msgId, session.sourceChatId)
        continue
      }

      if (payload.type === 'assign_role') {
        const contactId = typeof (payload as { contactId?: unknown }).contactId === 'number'
          ? (payload as { contactId: number }).contactId : null
        const role = typeof (payload as { role?: unknown }).role === 'string'
          ? (payload as { role: string }).role : null
        const senderAddr = typeof (payload as { senderAddr?: unknown }).senderAddr === 'string'
          ? (payload as { senderAddr: string }).senderAddr : null
        await handleAssignRole(ctx, session.msgId, session.sourceChatId, contactId, role, senderAddr)
        continue
      }
    }

    // Persist the high-water serial so a dispatcher restart doesn't
    // replay old create/bind/edit actions and create duplicate chats.
    const maxSerial = updates.reduce((m, u) => Math.max(m, u.serial ?? 0), 0)
    if (session && maxSerial > (session.lastSerial ?? 0)) {
      session.lastSerial = maxSerial
      persistSessions()
    }
  },
}
