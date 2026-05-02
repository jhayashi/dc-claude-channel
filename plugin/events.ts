/**
 * Structured JSONL logs of DC runtime events.
 *
 * Streams (each one line per event, one file per UTC day):
 *   $DC_EVENT_DIR/tools-<YYYY-MM-DD>.log — every DC tool call
 *   $DC_EVENT_DIR/turns-<YYYY-MM-DD>.log — every subagent turn
 *   $DC_EVENT_DIR/permissions-<YYYY-MM-DD>.log — every permission decision
 *   $DC_EVENT_DIR/webxdc-<YYYY-MM-DD>.log       — every inbound WebXDC update
 * (default dir: $DC_STATE_DIR/events/ or ~/.claude/channels/deltachat/events/).
 *
 * Filename uses the UTC date at write time; rotation happens implicitly
 * when the date rolls over (no in-process rotation, no mid-day churn).
 *
 * Sync append (~0.1-2ms typical) is fine: tool/turn runtimes dominate. The
 * logger swallows its own errors — observability must never kill the
 * caller. On any write failure the event is dropped and a debug line is
 * written to the normal log.
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface ToolCallEvent {
  /** ISO 8601 UTC timestamp. */
  ts: string
  /** Whether the call came from the terminal CC session or a subagent. */
  source: 'subagent' | 'terminal'
  /** Raw tool name. */
  tool: string
  /** Chat the subagent is bound to. Null for terminal calls. */
  callerChatId: number | null
  /** Owner contact of the caller chat. Null if legacy/terminal. */
  callerContactId: number | null
  /** `chat_id` argument if present (the chat the tool is acting on). */
  argChatId: number | null
  /** Owner contact of the target chat, if different from caller. */
  targetOwner: number | null
  /** Tool runtime in ms. */
  durationMs: number
  /** True iff no throw and the tool result did not set isError. */
  ok: boolean
  /**
   * Categorical error code when !ok. See the socket server and server.ts
   * terminal handler for the canonical set: rate_limited, unknown_tool,
   * tool_crash, chat_mismatch, install_pending, tool_error.
   */
  errorCode: string | null
  /**
   * Single-line stringified args with sensitive fields redacted. Capped
   * at 120 chars so the line stays easy to scan.
   */
  argPreview: string
  /**
   * Turn this tool call belongs to. Populated for subagent calls when the
   * dispatcher has an in-flight turn; null for terminal calls (no turn
   * concept) and for subagent calls that arrive outside a turn window
   * (e.g. permission auto-approve replay).
   */
  turnId?: string | null
  /**
   * Capability the tool annotation declares it requires (v1.3 slice 3).
   * Null when the tool isn't annotated; absent on records older than v1.3.
   */
  requiredCapability?: string | null
  /**
   * Resolved capability bundle of the originator at call time. `["*"]` for
   * terminal calls (the terminal IS the subscriber); `[]` for unknown
   * contacts; otherwise the contact's role bundle or explicit override.
   */
  originatorCapabilities?: string[]
  /**
   * Slice 3: `allow` if the originator's bundle covers the required
   * capability, `would_deny` if it doesn't. Pure observability — slice 4
   * flips `would_deny` to a hard refuse.
   */
  capabilityDecision?: 'allow' | 'would_deny'
}

/** Taxonomy of subagent turn exit reasons. See plans/2026-04-20-slices-2-5-decisions.md. */
export type TurnExitReason =
  | 'completed'
  | 'idle'
  | 'lru_evict'
  | 'turn_timeout'
  | 'crash'
  | 'user_abort'
  | 'resume_fallback'

export interface TurnEvent {
  /** ISO 8601 UTC timestamp at turn start. */
  ts: string
  /** Unique id assigned when the turn begins (see SubagentCache.runNow). */
  turnId: string
  /** Chat this turn ran in. */
  chatId: number
  /** Bound agent id (reads binding at emit time). Null if binding went away. */
  agentId: string | null
  /** Claude session UUID used for this turn. Null if unavailable. */
  sessionId: string | null
  /** Spawn cost absorbed by this turn — 0 for cache-hit turns. */
  spawnColdMs: number
  /** Wall-clock duration of the turn (start of runNow → completion/throw). */
  durationMs: number
  /** Count of DC tool calls routed through the dispatcher during this turn. */
  toolCalls: number
  exitReason: TurnExitReason
}

/**
 * Arg keys whose value is replaced with <redacted> in argPreview. Applied
 * to top-level keys only; we never log nested contents.
 */
const REDACT_KEYS = new Set([
  'text',
  'content',
  'body',
  'secret',
  'password',
  'token',
  'email',
])

const DEFAULT_DIR = process.env.DC_EVENT_DIR
  ?? (process.env.DC_STATE_DIR
    ? join(process.env.DC_STATE_DIR, 'events')
    : join(homedir(), '.claude', 'channels', 'deltachat', 'events'))

let _eventDir = DEFAULT_DIR

export function getEventDir(): string { return _eventDir }

export function setEventDir(dir: string): void { _eventDir = dir }

/**
 * Build the per-day file path for a given stream prefix. UTC so log lines
 * are monotonic across timezones and daylight-savings transitions.
 */
function pathForDate(stream: string, d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return join(_eventDir, `${stream}-${y}-${m}-${day}.log`)
}

/**
 * Format args as `k1=v1 k2=v2`, redacting sensitive keys and truncating
 * at 120 chars. Non-string values are coerced via String(); objects get
 * their JSON.stringify, clipped.
 */
export function buildArgPreview(args: Record<string, unknown> | null | undefined): string {
  if (!args || typeof args !== 'object') return ''
  const parts: string[] = []
  for (const [k, v] of Object.entries(args)) {
    if (REDACT_KEYS.has(k)) {
      parts.push(`${k}=<redacted>`)
      continue
    }
    let s: string
    if (v === null || v === undefined) s = String(v)
    else if (typeof v === 'string') s = v
    else if (typeof v === 'number' || typeof v === 'boolean') s = String(v)
    else {
      try { s = JSON.stringify(v) } catch { s = '<unserializable>' }
    }
    // Keep per-value length sane so one long field doesn't eat the whole preview.
    if (s.length > 40) s = s.slice(0, 37) + '...'
    parts.push(`${k}=${s}`)
  }
  const joined = parts.join(' ')
  return joined.length > 120 ? joined.slice(0, 117) + '...' : joined
}

function appendLine(stream: string, ts: string, payload: unknown, onWriteError?: (err: unknown) => void): void {
  try {
    mkdirSync(_eventDir, { recursive: true })
    appendFileSync(pathForDate(stream, new Date(ts)), JSON.stringify(payload) + '\n')
  } catch (err) {
    onWriteError?.(err)
  }
}

/**
 * Append one tool-call event line. Swallows errors — observability must
 * never affect tool execution.
 */
export function logToolCall(
  ev: ToolCallEvent,
  onWriteError?: (err: unknown) => void,
): void {
  appendLine('tools', ev.ts, ev, onWriteError)
}

/** Append one subagent-turn event line. Swallows errors, like logToolCall. */
export function logTurn(
  ev: TurnEvent,
  onWriteError?: (err: unknown) => void,
): void {
  appendLine('turns', ev.ts, ev, onWriteError)
}

/** Final decision on a permission prompt. */
export type PermissionVerdict = 'allow' | 'deny'

/**
 * Why the verdict was reached.
 *   user_allow / user_deny       — the owner tapped Allow or Deny in the WebXDC card
 *   skip_auto                    — bypassed by skip-permissions mode (no user prompt)
 *   capability_deny              — v1.3 capability gate refused the call:
 *                                  originator's bundle didn't cover the tool's
 *                                  requiresCapability annotation
 *   capability_lookup_error      — v1.3 capability gate fail-closed on a
 *                                  principal-store error (corrupt JSON, EACCES,
 *                                  etc.). Same outcome as deny; the separate
 *                                  reason makes the operator's `jq` queries
 *                                  honest about what actually failed.
 */
export type PermissionReason =
  | 'user_allow'
  | 'user_deny'
  | 'skip_auto'
  | 'capability_deny'
  | 'capability_lookup_error'
  | 'capability_invalid_requestor'

export interface PermissionEvent {
  ts: string
  chatId: number
  agentId: string | null
  tool: string
  /** Redacted, clipped stringification of the tool's input — same rules as argPreview. */
  inputPreview: string
  verdict: PermissionVerdict
  reason: PermissionReason
  /** True iff the dispatcher gave up waiting and defaulted to deny. */
  timedOut: boolean
  /** Wall-clock ms from prompt arrival to verdict (0 for skip_auto). */
  durationMs: number
  /** v1.3 capability gate: contact whose caps were checked (null for terminal). */
  originatorContactId?: number | null
  /** v1.3 capability gate: capability the tool annotation declared. */
  requiredCapability?: string
  /** v1.3 capability gate: originator's resolved bundle at the moment of decision. */
  originatorCapabilities?: string[]
}

/** Append one permission-decision event line. Swallows errors. */
export function logPermission(
  ev: PermissionEvent,
  onWriteError?: (err: unknown) => void,
): void {
  appendLine('permissions', ev.ts, ev, onWriteError)
}

export interface WebXDCEvent {
  ts: string
  /** Message id hosting the WebXDC app. */
  msgId: number
  /** Chat the update arrived in. */
  chatId: number
  /** Registered app id (e.g. 'permissions', 'file-reviewer'); null for updates routed to unregistered msgIds. */
  appId: string | null
  /** Whether the update passed owner verification (false for group-chat updates from non-owners). */
  ownerVerified: boolean
  /** `payload.type` convention used by dc-claude-channel apps; null when absent. */
  payloadType: string | null
  /** Serialized payload byte length (UTF-8). 0 when payload is null. */
  payloadSize: number
}

/** Append one inbound-WebXDC-update event line. Swallows errors. */
export function logWebXDC(
  ev: WebXDCEvent,
  onWriteError?: (err: unknown) => void,
): void {
  appendLine('webxdc', ev.ts, ev, onWriteError)
}

/**
 * Why a role was assigned to a contact (v1.3 slice 6).
 *   terminal_pair — recordContactPair fired during /deltachat:setup;
 *                   role is always `subscriber` for this path.
 *   picked        — subscriber explicitly chose the role via the XDC
 *                   picker (slice 7).
 */
export type RoleAssignmentReason = 'terminal_pair' | 'picked'

export interface RoleAssignmentEvent {
  ts: string
  /**
   * Contact whose role was set/changed. Required.
   */
  assigneeContactId: number
  /**
   * Role assigned (subscriber / trusted-agent / family-member / untrusted-agent / guest).
   */
  assignedRole: string
  /**
   * Previous role on disk, or null if this is a fresh assignment
   * (no principal record existed, or record had no role field).
   */
  previousRole: string | null
  /**
   * The actor responsible for the assignment. For `terminal_pair`,
   * null (the terminal session is implicit). For `picked`, the
   * subscriber's contactId who drove the XDC picker.
   */
  assignerContactId: number | null
  reason: RoleAssignmentReason
}

/**
 * Append one role-assignment event line. Same write discipline as the
 * other event streams — swallows errors, observability never affects
 * the caller. Lands in the same `permissions-<date>.log` stream as the
 * existing capability-deny entries; an operator running
 * `jq 'select(.assignedRole)'` filters role events.
 */
export function logRoleAssignment(
  ev: RoleAssignmentEvent,
  onWriteError?: (err: unknown) => void,
): void {
  appendLine('permissions', ev.ts, ev, onWriteError)
}

export interface AutoPairDenialEvent {
  ts: string
  type: 'auto_pair_denied'
  chatId: number
  contactId: number
  role: string
}

export function logAutoPairDenial(ev: AutoPairDenialEvent): void {
  appendLine('permissions', ev.ts, ev)
}
